

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "start_sync") {
        const hostname = window.location.hostname;

        if (hostname.includes("zomato.com")) {
            fetchZomatoOrders().then(orders => {
                chrome.storage.local.set({ zomatoData: orders, lastSyncZomato: new Date().toISOString() }, () => {
                    sendResponse({ status: "success", count: orders.length, platform: "Zomato" });
                });
            }).catch(err => {
                console.error("Zomato Sync failed", err);
                sendResponse({ status: "error", message: err.message });
            });
        } else if (hostname.includes("swiggy.com")) {
            fetchSwiggyOrders().then(orders => {
                chrome.storage.local.set({ swiggyData: orders, lastSyncSwiggy: new Date().toISOString() }, () => {
                    sendResponse({ status: "success", count: orders.length, platform: "Swiggy" });
                });
            }).catch(err => {
                console.error("Swiggy Sync failed", err);
                sendResponse({ status: "error", message: err.message });
            });
        } else {
            sendResponse({ status: "error", message: "Not on a supported food delivery site." });
        }

        return true; // Keep channel open for async response
    }
});

async function fetchZomatoOrders() {
    let allOrders = [];
    let page = 1;
    let hasMore = true;

    // Attempt to fetch from the known internal API endpoint
    // Note: This endpoint might change. The user might need to be logged in.
    // URL: https://www.zomato.com/webroutes/user/orders?page=1

    while (hasMore) {
        try {
            const response = await fetch(`https://www.zomato.com/webroutes/user/orders?page=${page}`);

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const data = await response.json();

            // Extract raw orders from the response
            const rawOrders = data.entities && data.entities.ORDER ? Object.values(data.entities.ORDER) : [];

            if (rawOrders.length === 0) {
                hasMore = false;
                break;
            }

            // DUPLICATE CHECK: Only process orders we haven't seen in THIS session
            const existingIds = new Set(allOrders.map(o => o.orderId));
            const newOrders = rawOrders.filter(o => !existingIds.has(o.orderId));

            if (newOrders.length === 0) {
                hasMore = false;
                break;
            }

            // MAPPING & FILTERING: Use a blacklist approach
            const failureKeywords = [
                "failed", "cancelled", "unpaid", "returned", "payment failed",
                "retry", "unsuccessful", "pending", "aborted", "incomplete",
                "void", "rejected", "payment pending", "not paid"
            ];
            const successKeywords = ["delivered", "completed", "success", "picked up"];

            const processedOrders = newOrders.map(order => {
                let rawStatus = "";
                if (order.orderStatus && order.orderStatus.statusText) {
                    rawStatus = order.orderStatus.statusText;
                } else if (order.status) {
                    rawStatus = order.status;
                }

                const statusText = String(rawStatus || "").toLowerCase();

                // Map the order
                return {
                    orderId: order.orderId,
                    totalCost: order.totalCost,
                    orderDate: order.orderDate,
                    restaurantName: order.resInfo ? order.resInfo.name : "Unknown",
                    dishString: order.dishString || "",
                    status: statusText
                };
            }).filter(order => {
                const statusText = order.status;

                // Is it a known failure?
                // Numeric "1" identified as failure/incomplete from console logs
                const isFailure = failureKeywords.some(kw => statusText.includes(kw)) || statusText === "1";
                // Is it an explicit success?
                // Numeric "6" identified as successful from console logs
                const isSuccess = successKeywords.some(kw => statusText.includes(kw)) || statusText === "6";

                // If it's a known failure, block it. Otherwise, allow it (Defensive approach)
                return !isFailure;
            });

            if (processedOrders.length > 0) {
                allOrders = allOrders.concat(processedOrders);
            }

            page++;

            // Safety break
            if (page > 50) {
                console.warn("Reached page limit (50). Stopping.");
                hasMore = false;
            }

            // Random delay to be nice to the server
            await new Promise(r => setTimeout(r, 1000 + Math.random() * 1000));

            // Send Progress
            chrome.runtime.sendMessage({
                action: "sync_progress",
                message: `Fetched Page ${page - 1} (${allOrders.length} orders so far)...`,
                progress: 50
            });

        } catch (e) {
            console.error("Error fetching page " + page, e);
            hasMore = false;
        }
    }

    return allOrders;
}



async function fetchSwiggyOrders() {
    let allOrders = [];
    let page = 1;
    let hasMore = true;
    let cursor = null; // Store order_id of the last order

    while (hasMore) {
        try {
            // Construct URL with cursor if available, otherwise just page 1
            let url = "https://www.swiggy.com/dapi/order/all";
            if (cursor) {
                url += `?order_id=${cursor}`;
            } else {
                url += `?page=${page}`;
            }


            const response = await fetch(url);

            if (!response.ok) {
                console.warn("Swiggy fetch error", response.status);
                if (response.status === 401 || response.status === 403) {
                    throw new Error("Please log in to Swiggy first.");
                }
                break;
            }

            const data = await response.json();

            if (!data.data || !data.data.orders) {
                hasMore = false;
                break;
            }

            const rawOrders = data.data.orders;

            if (rawOrders.length === 0) {
                hasMore = false;
                break;
            }

            // DUPLICATE CHECK
            const existingIds = new Set(allOrders.map(o => o.orderId));
            const newOrders = rawOrders.filter(o => !existingIds.has(o.order_id));

            if (newOrders.length === 0) {
                hasMore = false;
                break;
            }

            const processedOrders = newOrders.map(order => ({
                orderId: order.order_id,
                totalCost: "₹" + (order.order_total || 0),
                orderDate: new Date(order.order_time).toLocaleString('en-US', { month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: 'numeric', hour12: true }).replace(" at ", ", "),
                restaurantName: order.restaurant_name,
                dishString: order.order_items ? order.order_items.map(i => i.name).join(", ") : ""
            }));

            allOrders = allOrders.concat(processedOrders);

            // Update cursor to the last order's ID
            cursor = rawOrders[rawOrders.length - 1].order_id;
            page++;

            // Safety break - increased for heavy users
            if (page > 200) {
                hasMore = false;
            }

            // Delay
            await new Promise(r => setTimeout(r, 1000));

            // Send Progress
            chrome.runtime.sendMessage({
                action: "sync_progress",
                message: `Fetched ${allOrders.length} orders...`,
                progress: 50
            });

        } catch (e) {
            console.error("Error fetching Swiggy page " + page, e);
            hasMore = false;
        }
    }

    return allOrders;
}
