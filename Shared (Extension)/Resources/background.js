const STORAGE_KEY = "disabledDomains";
const FIRST_RULE_ID = 10_000;

let updateQueue = Promise.resolve();

function normaliseHostname(value) {
	return String(value ?? "")
		.trim()
		.toLowerCase()
		.replace(/^\.+|\.+$/g, "");
}

function hostnameFromUrl(value) {
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:"
			? normaliseHostname(url.hostname)
			: null;
	} catch {
		return null;
	}
}

async function readDomains() {
	const stored = await browser.storage.local.get(STORAGE_KEY);
	const domains = Array.isArray(stored[STORAGE_KEY]) ? stored[STORAGE_KEY] : [];
	return [...new Set(domains.map(normaliseHostname).filter(Boolean))].sort();
}

function rulesForDomains(domains) {
	return domains.flatMap((domain, index) => {
		const ruleId = FIRST_RULE_ID + index * 2;
		return [
			{
				id: ruleId,
				priority: 2,
				action: {
					type: "modifyHeaders",
					responseHeaders: [
						{
							header: "content-security-policy",
							operation: "set",
							value: "script-src 'none'; worker-src 'none'; object-src 'none'",
						},
					],
				},
				condition: {
					requestDomains: [domain],
					resourceTypes: ["main_frame", "sub_frame"],
				},
			},
			{
				id: ruleId + 1,
				priority: 1,
				action: { type: "block" },
				condition: {
					urlFilter: "*",
					initiatorDomains: [domain],
					resourceTypes: ["script"],
				},
			},
		];
	});
}

async function replaceRules(domains) {
	const existing = await browser.declarativeNetRequest.getDynamicRules();
	await browser.declarativeNetRequest.updateDynamicRules({
		removeRuleIds: existing
			.filter((rule) => rule.id >= FIRST_RULE_ID)
			.map((rule) => rule.id),
		addRules: rulesForDomains(domains),
	});
}

async function toggleDomain(hostname) {
	const domains = new Set(await readDomains());
	const disabled = !domains.has(hostname);
	disabled ? domains.add(hostname) : domains.delete(hostname);
	const nextDomains = [...domains].sort();

	await replaceRules(nextDomains);
	await browser.storage.local.set({ [STORAGE_KEY]: nextDomains });
	return disabled;
}

async function updateBadge(tabId, url) {
	const hostname = hostnameFromUrl(url);
	const disabled =
		hostname !== null && (await readDomains()).includes(hostname);
	await browser.action.setBadgeText({ tabId, text: disabled ? "OFF" : "" });
	if (disabled) {
		await browser.action.setBadgeBackgroundColor({ tabId, color: "#D94B3D" });
	}
	await browser.action.setTitle({
		tabId,
		title: disabled
			? "Enable JavaScript for this domain"
			: "Disable JavaScript for this domain",
	});
}

browser.action.onClicked.addListener((tab) => {
	const hostname = hostnameFromUrl(tab.url);
	if (!hostname || !Number.isInteger(tab.id)) {
		return;
	}

	const operation = updateQueue.then(async () => {
		const disabled = await toggleDomain(hostname);
		await updateBadge(tab.id, tab.url);
		await browser.tabs.reload(tab.id, { bypassCache: true });
		return disabled;
	});

	updateQueue = operation.catch(async (error) => {
		console.error(error);
		await browser.action
			.setBadgeText({ tabId: tab.id, text: "!" })
			.catch(() => undefined);
		await browser.action
			.setBadgeBackgroundColor({ tabId: tab.id, color: "#D94B3D" })
			.catch(() => undefined);
		await browser.action
			.setTitle({
				tabId: tab.id,
				title: error?.message ?? "NoJS could not update this domain",
			})
			.catch(() => undefined);
	});
});

browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
	if (changeInfo.url || changeInfo.status === "complete") {
		updateBadge(tabId, changeInfo.url ?? tab.url).catch(console.error);
	}
});

browser.tabs.onActivated.addListener(async ({ tabId }) => {
	try {
		const tab = await browser.tabs.get(tabId);
		await updateBadge(tabId, tab.url);
	} catch (error) {
		console.error(error);
	}
});

browser.runtime.onInstalled.addListener(() => {
	readDomains().then(replaceRules).catch(console.error);
});
