let allOrders = []; // Store all fetched orders
let charts = {}; // Store chart instances
let currentPlatform = 'zomato'; // 'zomato' or 'swiggy'

document.addEventListener('DOMContentLoaded', () => {
    const syncBtn = document.getElementById('sync-btn');
    const syncStatus = document.getElementById('sync-status');

    // Platform Switcher logic
    document.getElementById('btn-zomato').addEventListener('click', () => switchPlatform('zomato'));
    document.getElementById('btn-swiggy').addEventListener('click', () => switchPlatform('swiggy'));

    // Filter Elements
    const startDateInput = document.getElementById('start-date');
    const endDateInput = document.getElementById('end-date');
    const filterBtns = document.querySelectorAll('.filter-btn');

    // Smart platform detection: Find the most recently active Swiggy/Zomato tab
    chrome.windows.getAll({ populate: true, windowTypes: ['normal'] }, (windows) => {
        let detectedPlatform = 'zomato'; // Default
        let mostRecentTab = null;
        let mostRecentTime = 0;

        // Iterate through all normal browser windows
        windows.forEach(window => {
            window.tabs.forEach(tab => {
                if (tab.url && (tab.url.includes('swiggy.com') || tab.url.includes('zomato.com'))) {
                    if (tab.active) {
                        mostRecentTab = tab;
                        mostRecentTime = Infinity; // Active tabs take priority
                    } else if (tab.lastAccessed && tab.lastAccessed > mostRecentTime) {
                        mostRecentTab = tab;
                        mostRecentTime = tab.lastAccessed;
                    }
                }
            });
        });

        // Determine platform from the most recent tab
        if (mostRecentTab) {
            if (mostRecentTab.url.includes('swiggy.com')) {
                detectedPlatform = 'swiggy';
            } else if (mostRecentTab.url.includes('zomato.com')) {
                detectedPlatform = 'zomato';
            }
        }

        // Initialize with detected or default platform
        switchPlatform(detectedPlatform);
    });

    syncBtn.addEventListener('click', async () => {
        syncStatus.textContent = "Initializing Sync...";
        document.getElementById('progress-container').classList.remove('hidden');
        document.getElementById('progress-fill').style.width = '5%';
        document.getElementById('progress-text').textContent = "Starting...";

        try {
            const urlPattern = currentPlatform === 'zomato' ? "*://*.zomato.com/*" : "*://*.swiggy.com/*";
            const targetUrl = currentPlatform === 'zomato' ? "https://www.zomato.com" : "https://www.swiggy.com";

            const tabs = await chrome.tabs.query({ url: urlPattern });

            if (tabs.length === 0) {
                chrome.tabs.create({ url: targetUrl });
                syncStatus.textContent = `Opened ${currentPlatform === 'zomato' ? 'Zomato' : 'Swiggy'}. Please login and click Sync again.`;
                document.getElementById('progress-container').classList.add('hidden');
                return;
            }

            const activeTab = tabs[0];

            chrome.tabs.sendMessage(activeTab.id, { action: "start_sync" }, (response) => {
                if (chrome.runtime.lastError) {
                    syncStatus.textContent = "Error: Refresh the page and try again.";
                    document.getElementById('progress-container').classList.add('hidden');
                    return;
                }

                if (response && response.status === "success") {
                    syncStatus.textContent = `Synced ${response.count} orders from ${response.platform}!`;
                    document.getElementById('progress-fill').style.width = '100%';
                    document.getElementById('progress-text').textContent = "Complete!";

                    setTimeout(() => {
                        document.getElementById('progress-container').classList.add('hidden');
                    }, 2000);

                    if (response.platform.toLowerCase() !== currentPlatform) {
                        switchPlatform(response.platform.toLowerCase());
                    } else {
                        loadData();
                    }
                } else {
                    syncStatus.textContent = "Sync failed. Ensure you are logged in.";
                    document.getElementById('progress-container').classList.add('hidden');
                }
            });

        } catch (e) {
            console.error(e);
            document.getElementById('progress-container').classList.add('hidden');
            syncStatus.textContent = "Sync error. Please try again.";
        }
    });

    // Listen for progress updates from content script
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === "sync_progress") {
            const progressBar = document.getElementById('progress-fill');
            const progressText = document.getElementById('progress-text');
            const container = document.getElementById('progress-container');

            container.classList.remove('hidden');
            progressText.textContent = request.message;

            let currentWidth = parseFloat(progressBar.style.width) || 5;
            if (currentWidth < 90) {
                progressBar.style.width = (currentWidth + 5) + '%';
            }
        }
    });

    // Date Input Listeners
    startDateInput.addEventListener('change', () => applyDateFilter());
    endDateInput.addEventListener('change', () => applyDateFilter());

    // Quick Filter Buttons
    filterBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            filterBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');

            const range = btn.dataset.range;
            const end = new Date();
            let start = new Date();

            if (range === 'all') {
                startDateInput.value = '';
                endDateInput.value = '';
                applyDateFilter();
                return;
            }

            start.setDate(end.getDate() - parseInt(range));
            startDateInput.valueAsDate = start;
            endDateInput.valueAsDate = end;
            applyDateFilter();
        });
    });
});

let isFirstLoad = true; // Track if this is the first platform switch

function switchPlatform(platform) {
    // On first load, always proceed even if platform matches default
    if (!isFirstLoad && currentPlatform === platform) return;

    isFirstLoad = false; // Mark that we've loaded once

    currentPlatform = platform;

    // UI Updates
    document.querySelectorAll('.platform-btn').forEach(btn => btn.classList.remove('active'));
    document.getElementById(`btn-${platform}`).classList.add('active');

    // Theme Update (CSS)
    if (platform === 'swiggy') {
        document.body.classList.add('swiggy-theme');
        document.querySelector('.logo h2').textContent = "Swiggy Tracker";
    } else {
        document.body.classList.remove('swiggy-theme');
        document.querySelector('.logo h2').textContent = "Zomato Tracker";
    }

    // Reset Data
    allOrders = [];
    processOrders([]); // Clear UI first

    // Reload Data
    loadData();
}

function loadData() {
    const dataKey = currentPlatform === 'swiggy' ? 'swiggyData' : 'zomatoData';
    const syncKey = currentPlatform === 'swiggy' ? 'lastSyncSwiggy' : 'lastSyncZomato';

    // Legacy fallback for Zomato
    const keys = [dataKey, syncKey];
    if (currentPlatform === 'zomato') keys.push('orders');

    chrome.storage.local.get(keys, (result) => {
        let orders = result[dataKey];

        // Migration check for Zomato
        if (currentPlatform === 'zomato' && !orders && result.orders) {
            orders = result.orders;
            chrome.storage.local.set({ zomatoData: orders });
        }

        const lastSync = result[syncKey] || (currentPlatform === 'zomato' ? result.lastSync : null);

        if (lastSync) {
            const syncDate = new Date(lastSync);
            const istTime = syncDate.toLocaleString('en-IN', {
                timeZone: 'Asia/Kolkata',
                dateStyle: 'medium',
                timeStyle: 'short'
            });
            document.getElementById('sync-status').textContent = `Last synced: ${istTime}`;
        } else {
            document.getElementById('sync-status').textContent = `Last synced: Never`;
        }

        if (orders && orders.length > 0) {
            // DEDUPLICATION STEP: Ensure NO duplicates in storage
            const seenIds = new Set();
            const uniqueOrders = [];
            let hadDuplicates = false;

            orders.forEach(o => {
                if (!seenIds.has(o.orderId)) {
                    seenIds.add(o.orderId);
                    uniqueOrders.push(o);
                } else {
                    hadDuplicates = true;
                }
            });

            if (hadDuplicates) {
                const update = {};
                update[dataKey] = uniqueOrders;
                chrome.storage.local.set(update);
                orders = uniqueOrders;
            }

            allOrders = orders.map(o => {
                let dateStr = o.orderDate;
                if (dateStr && typeof dateStr === 'string' && dateStr.includes(' at ')) {
                    dateStr = dateStr.replace(' at ', ' ');
                }

                let cost = 0;
                if (typeof o.totalCost === 'string') {
                    cost = parseFloat(o.totalCost.replace(/[^0-9.]/g, ''));
                } else {
                    cost = o.totalCost;
                }

                return {
                    ...o,
                    totalCost: cost, // Normalize for internal use
                    parsedDate: new Date(dateStr || Date.now())
                };
            }).filter(o => !isNaN(o.parsedDate));

            applyDateFilter();
        } else {
            processOrders([]); // Clear UI
        }
    });
}

function applyDateFilter() {
    const startVal = document.getElementById('start-date').value;
    const endVal = document.getElementById('end-date').value;

    let filtered = allOrders;

    if (startVal) {
        const start = new Date(startVal);
        start.setHours(0, 0, 0, 0);
        filtered = filtered.filter(o => o.parsedDate >= start);
    }

    if (endVal) {
        const end = new Date(endVal);
        end.setHours(23, 59, 59, 999);
        filtered = filtered.filter(o => o.parsedDate <= end);
    }

    processOrders(filtered);
}

function processOrders(orders) {
    let totalSpent = 0;
    const monthlyData = {};
    const restaurantData = {};
    const timeOfDayData = {
        'Morning (6-12)': 0,
        'Afternoon (12-17)': 0,
        'Evening (17-21)': 0,
        'Late Night (21-6)': 0
    };

    orders.forEach(order => {
        let amount = 0;
        if (typeof order.totalCost === 'string') {
            amount = parseFloat(order.totalCost.replace(/[^0-9.]/g, ''));
        } else if (typeof order.totalCost === 'number') {
            amount = order.totalCost;
        }

        if (isNaN(amount)) amount = 0;

        totalSpent += amount;

        const date = order.parsedDate;
        const monthKey = `${date.toLocaleString('default', { month: 'short' })} ${date.getFullYear()}`;

        monthlyData[monthKey] = (monthlyData[monthKey] || 0) + amount;

        const resName = order.restaurantName || "Unknown Restaurant";
        restaurantData[resName] = (restaurantData[resName] || 0) + amount;

        // Time of Day
        const hour = date.getHours();
        if (hour >= 6 && hour < 12) timeOfDayData['Morning (6-12)']++;
        else if (hour >= 12 && hour < 17) timeOfDayData['Afternoon (12-17)']++;
        else if (hour >= 17 && hour < 21) timeOfDayData['Evening (17-21)']++;
        else timeOfDayData['Late Night (21-6)']++;
    });

    // Update UI
    document.getElementById('total-spent').textContent = `₹${totalSpent.toLocaleString()}`;
    document.getElementById('total-orders').textContent = orders.length;
    document.getElementById('avg-order').textContent = `₹${orders.length ? Math.round(totalSpent / orders.length) : 0}`;

    renderCharts(monthlyData, restaurantData, timeOfDayData);
    renderTopRestaurants(restaurantData);
    renderFavoriteFoods(orders);
}

function renderCharts(monthlyData, restaurantData, timeOfDayData) {
    // Destroy existing charts to prevent canvas reuse errors
    if (charts.monthly) charts.monthly.destroy();
    if (charts.category) charts.category.destroy();
    if (charts.timeOfDay) charts.timeOfDay.destroy();

    const isSwiggy = currentPlatform === 'swiggy'; // Define it here!

    // Monthly Chart
    const ctx = document.getElementById('monthlyChart').getContext('2d');
    const sortedMonths = Object.keys(monthlyData).sort((a, b) => {
        return new Date("1 " + a) - new Date("1 " + b);
    });

    const barColor = isSwiggy ? '#FC8019' : '#E23744';

    charts.monthly = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: sortedMonths,
            datasets: [{
                label: 'Monthly Spending (₹)',
                data: sortedMonths.map(m => monthlyData[m]),
                backgroundColor: barColor,
                borderRadius: 4
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            layout: {
                padding: {
                    bottom: 20
                }
            },
            scales: { y: { beginAtZero: true } }
        }
    });

    // Category/Restaurant Pie Chart
    const ctxPie = document.getElementById('categoryChart').getContext('2d');
    const sortedRes = Object.entries(restaurantData).sort((a, b) => b[1] - a[1]).slice(0, 5);

    const swiggyColors = ['#FC8019', '#E37417', '#C46210', '#FFA959', '#FFC58A'];
    const zomatoColors = ['#CB202D', '#2D2D2D', '#FF7E8B', '#E23744', '#B5B5B5'];

    charts.category = new Chart(ctxPie, {
        type: 'doughnut',
        data: {
            labels: sortedRes.map(x => x[0]),
            datasets: [{
                data: sortedRes.map(x => x[1]),
                backgroundColor: isSwiggy ? swiggyColors : zomatoColors
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            layout: {
                padding: {
                    bottom: 20
                }
            },
            plugins: {
                legend: {
                    position: 'bottom'
                }
            }
        }
    });

    // Time of Day Chart (Polar Area)
    const ctxTime = document.getElementById('timeOfDayChart').getContext('2d');
    const todColors = isSwiggy ? ['#FFC58A', '#FFA959', '#FC8019', '#2D2D2D'] : ['#FFE5E7', '#FF9AA5', '#E23744', '#2D2D2D'];

    charts.timeOfDay = new Chart(ctxTime, {
        type: 'polarArea',
        data: {
            labels: Object.keys(timeOfDayData),
            datasets: [{
                label: 'Orders',
                data: Object.values(timeOfDayData),
                backgroundColor: todColors
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            layout: { padding: { bottom: 30 } },
            scales: {
                r: {
                    pointLabels: { display: true, centerPointLabels: true, font: { size: 12 } },
                    ticks: { backdropColor: 'transparent' }
                }
            }
        }
    });
}

function renderTopRestaurants(restaurantData) {
    const list = document.getElementById('top-restaurants-list');
    list.innerHTML = '';

    const sorted = Object.entries(restaurantData).sort((a, b) => b[1] - a[1]).slice(0, 10);

    sorted.forEach(([name, amount], index) => {
        const li = document.createElement('li');
        li.className = 'restaurant-item';
        li.innerHTML = `
            <span class="res-name">${index + 1}. ${name}</span>
            <span class="res-amount">₹${amount.toLocaleString()}</span>
        `;
        list.appendChild(li);
    });
}

function renderFavoriteFoods(orders) {
    const foodCounts = {};

    orders.forEach(order => {
        if (order.dishString) {
            // Split by comma if multiple items, cleanup
            const items = order.dishString.split(',').map(i => i.trim());
            items.forEach(item => {
                // Remove quantity like "2 x " or "1 x " if present
                const cleanItem = item.replace(/^\d+\s*[xX]\s*/, '').trim();
                if (cleanItem) {
                    foodCounts[cleanItem] = (foodCounts[cleanItem] || 0) + 1;
                }
            });
        }
    });

    const sortedFoods = Object.entries(foodCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const list = document.getElementById('favorite-food-list');
    list.innerHTML = '';

    if (sortedFoods.length === 0) {
        list.innerHTML = '<li class="restaurant-item"><span class="res-name">No food details found</span></li>';
        return;
    }

    sortedFoods.forEach(([name, count], index) => {
        const li = document.createElement('li');
        li.className = 'restaurant-item';
        li.innerHTML = `
            <span class="res-name">${index + 1}. ${name}</span>
            <span class="res-amount">${count} orders</span>
        `;
        list.appendChild(li);
    });
}

