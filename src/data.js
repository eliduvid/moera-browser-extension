import browser from 'webextension-polyfill';
import AsyncLock from 'async-lock';
import ObjectPath from 'object-path';

const DEFAULT_CLIENT_URL = "https://client.moera.org/releases/latest";

const activeTabs = new Map();
const dataLock = new AsyncLock();

export async function isStorageV1() {
    const {settings, clientData} = await browser.storage.local.get(["settings", "clientData"]);
    return settings != null || clientData != null;
}

export async function migrateStorageToV2() {
    const {settings, clientData} = await browser.storage.local.get(["settings", "clientData"]);
    await browser.storage.local.clear();
    const clientUrl = ObjectPath.get(settings, "clientUrl", DEFAULT_CLIENT_URL);
    const data = {
        defaultClient: clientUrl === DEFAULT_CLIENT_URL,
        customClientUrl: clientUrl !== DEFAULT_CLIENT_URL ?  clientUrl : "",
    };
    const homeRoot = ObjectPath.get(clientData, "home.location");
    ObjectPath.del(clientData, "home.location");
    ObjectPath.del(clientData, "clientId");
    if (homeRoot) {
        data[`roots;${clientUrl}`] = [{url: homeRoot}];
        data[`currentRoot;${clientUrl}`] = homeRoot;
        data[`clientData;${clientUrl};${homeRoot}`] = clientData;
    }
    await browser.storage.local.set(data);
}

export async function getSettings() {
    let {defaultClient, customClientUrl} = await browser.storage.local.get(["defaultClient", "customClientUrl"]);
    defaultClient = defaultClient != null ? defaultClient : true;
    customClientUrl = customClientUrl ? customClientUrl : DEFAULT_CLIENT_URL;
    return {defaultClient, customClientUrl};
}

export async function setSettings({defaultClient, customClientUrl}) {
    await browser.storage.local.set({defaultClient, customClientUrl});
}

export async function getClientUrl() {
    const {defaultClient, customClientUrl} = await browser.storage.local.get(["defaultClient", "customClientUrl"]);
    return defaultClient == null || defaultClient ? DEFAULT_CLIENT_URL : customClientUrl;
}

export async function addTab(tabId) {
    const clientUrl = await getClientUrl();
    activeTabs.set(tabId, {clientUrl});
}

function broadcastMessage(message, clientUrl) {
    let closedTabs = [];
    activeTabs.forEach((value, tabId) => {
        if (value.clientUrl === clientUrl) {
            browser.tabs.sendMessage(tabId, message)
                .catch(() => closedTabs.push(tabId));
        }
    });
    closedTabs.forEach(tabId => activeTabs.delete(tabId));
}

async function getTabClientUrl(tabId) {
    const {clientUrl} = activeTabs.get(tabId);
    return clientUrl != null ? clientUrl : await getClientUrl();
}

function loadedData(homeRoot, clientData, roots) {
    let data = {};
    if (homeRoot) {
        data = {...clientData};
        ObjectPath.set(data, "home.location", homeRoot);
    }
    if (roots != null) {
        data = {...data, roots}
    }
    return {
        source: "moera",
        action: "loadedData",
        payload: {
            version: 2,
            ...data
        }
    };
}

function getRootName(roots, location) {
    const root = roots.find(r => r.url === location);
    return root ? root.name : null;
}

function setRoot(roots, location, nodeName) {
    if (roots.find(r => r.url === location) == null) {
        roots.push({url: location, name: nodeName});
    } else {
        roots = roots.map(r => r.url === location ? {url: location, name: nodeName} : r);
    }
    return roots;
}

export async function loadData(tabId) {
    const clientUrl = await getTabClientUrl(tabId);
    const rootKey = `currentRoot;${clientUrl}`;
    const rootsKey = `roots;${clientUrl}`;
    const {[rootKey]: homeRoot, [rootsKey]: roots} = await browser.storage.local.get([rootKey, rootsKey]);
    if (!homeRoot) {
        return loadedData();
    }
    const dataKey = `clientData;${clientUrl};${homeRoot}`;
    const {[dataKey]: clientData} = await browser.storage.local.get(dataKey);
    ObjectPath.set(clientData, "home.nodeName", getRootName(roots, homeRoot));
    return loadedData(homeRoot, clientData, roots);
}

export async function storeData(tabId, data) {
    const clientUrl = await getTabClientUrl(tabId);
    const result = await dataLock.acquire("clientData", async () => {
        const rootKey = `currentRoot;${clientUrl}`;
        const rootsKey = `roots;${clientUrl}`;
        let {[rootKey]: homeRoot, [rootsKey]: roots} = await browser.storage.local.get([rootKey, rootsKey]);
        if (roots == null) {
            roots = [];
        }
        const location = ObjectPath.get(data, "home.location");
        const nodeName = ObjectPath.get(data, "home.nodeName");
        if (location) {
            if (homeRoot !== location) {
                await browser.storage.local.set({[rootKey]: location});
                homeRoot = location;
            }
            roots = setRoot(roots, homeRoot, nodeName);
            await browser.storage.local.set({[rootsKey]: roots});
        }
        if (!homeRoot) {
            return loadedData();
        }

        const dataKey = `clientData;${clientUrl};${homeRoot}`;
        let {[dataKey]: clientData} = await browser.storage.local.get(dataKey);
        clientData = {
            ...clientData,
            ...data
        };
        ObjectPath.del(clientData, "home.location");

        const storedClientData = {...clientData};
        ObjectPath.del(storedClientData, "clientId");
        ObjectPath.del(storedClientData, "home.nodeName");
        browser.storage.local.set({[dataKey]: storedClientData});

        return loadedData(homeRoot, clientData, roots);
    });
    broadcastMessage(result, clientUrl);
}

export async function deleteData(tabId, location) {
    const clientUrl = await getTabClientUrl(tabId);
    const data = await dataLock.acquire("clientData", async () => {
        const rootKey = `currentRoot;${clientUrl}`;
        const rootsKey = `roots;${clientUrl}`;
        let {[rootKey]: homeRoot, [rootsKey]: roots} = await browser.storage.local.get([rootKey, rootsKey]);
        if (!location) {
            location = homeRoot;
        }
        if (roots.find(r => r.url === homeRoot) == null && location !== homeRoot) {
            return null;
        }
        roots = roots.filter(r => r.url !== location);
        await browser.storage.local.set({[rootsKey]: roots});
        await browser.storage.local.remove(`clientData;${clientUrl};${location}`);

        let nodeName;
        if (location === homeRoot) {
            if (roots.length === 0) {
                await browser.storage.local.remove(rootKey);
                return loadedData(homeRoot, {}, roots);
            }
            homeRoot = roots[roots.length - 1].url;
            nodeName = roots[roots.length - 1].name;
            await browser.storage.local.set({[rootKey]: homeRoot});
        } else {
            nodeName = getRootName(roots, homeRoot);
        }
        const dataKey = `clientData;${clientUrl};${homeRoot}`;
        const {[dataKey]: clientData} = await browser.storage.local.get(dataKey);
        ObjectPath.set(clientData, "home.nodeName", nodeName);
        return loadedData(homeRoot, clientData, roots);
    });
    if (data != null) {
        broadcastMessage(data, clientUrl);
    }
}

export async function switchData(tabId, location) {
    const clientUrl = await getTabClientUrl(tabId);
    const data = await dataLock.acquire("clientData", async () => {
        const rootKey = `currentRoot;${clientUrl}`;
        const rootsKey = `roots;${clientUrl}`;
        let {[rootKey]: homeRoot, [rootsKey]: roots} = await browser.storage.local.get([rootKey, rootsKey]);
        if (roots == null) {
            roots = [];
        }

        const root = roots.find(r => r.url === location);
        if (!location || location === homeRoot || root == null) {
            return loadedData();
        }
        await browser.storage.local.set({[rootKey]: location});

        const dataKey = `clientData;${clientUrl};${location}`;
        const {[dataKey]: clientData} = await browser.storage.local.get(dataKey);
        ObjectPath.set(clientData, "home.nodeName", root.name);
        return loadedData(location, clientData, roots);
    });
    if (data != null) {
        broadcastMessage(data, clientUrl);
    }
}
