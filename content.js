

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

            // Check structure of response (based on typical Zomato web responses)
            // Usually data.entities.ORDER or similar
            // Adjusting based on common detailed structures found in research/experience
            // Since we can't verify exact structure without login, we will try to make this robust or user-editable if it breaks.
            // For now, assuming a standard structure or we might need to parse HTML if API fails.
            // Actually, webroutes/user/orders usually returns JSON.

            const rawOrders = data.entities ? Object.values(data.entities.ORDER) : [];

            const processedOrders = rawOrders.map(order => ({
                orderId: order.orderId,
                totalCost: order.totalCost, // Usually formatted string "₹1,200"
                orderDate: order.orderDate, // Sometimes timestamp or string
                restaurantName: order.resInfo ? order.resInfo.name : "Unknown",
                dishString: order.dishString || "" // Extract dish details
            }));

            if (processedOrders.length === 0) {
                hasMore = false;
            } else {
                allOrders = allOrders.concat(processedOrders);
                page++;
                // Safety break
                if (page > 20) hasMore = false;
            }

            // Random delay to be nice to the server
            await new Promise(r => setTimeout(r, 1000 + Math.random() * 1000));

            // Send Progress
            chrome.runtime.sendMessage({
                action: "sync_progress",
                message: `Fetched Page ${page} (${allOrders.length} orders so far)...`,
                progress: 50 // Indeterminate or estimated
            });

        } catch (e) {
            console.error("Error fetching page " + page, e);
            hasMore = false;
        }
    }

    // Fallback: If API returns nothing (maybe different structure or auth issue), try to parse DOM if current page is orders page?
    // Use what we have.
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
