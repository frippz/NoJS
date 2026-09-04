const STORAGE_KEY = "disabledDomains";
const FIRST_RULE_ID = 10_000;

const domainElement = document.querySelector("#domain");
const descriptionElement = document.querySelector("#description");
const statusElement = document.querySelector("#status");
const toggle = document.querySelector("#toggle");

let activeTab;
let hostname;

function normaliseHostname(value) {
	return String(value ?? "")
		.trim()
		.toLowerCase()
		.replace(/^\.+|\.+$/g, "");
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

async function saveDomainStatus(domain, disabled) {
	const domains = new Set(await readDomains());
	disabled ? domains.add(domain) : domains.delete(domain);
	const nextDomains = [...domains].sort();

	await replaceRules(nextDomains);
	await browser.storage.local.set({ [STORAGE_KEY]: nextDomains });
}

async function ensureWebsiteAccess(domain) {
	const origins = [`*://${domain}/*`];
	if (await browser.permissions.contains({ origins })) {
		return;
	}

	const granted = await browser.permissions.request({ origins });
	if (!granted) {
		throw new Error(
			"Website access is required to block JavaScript on this domain.",
		);
	}
}

function showUnavailable(message) {
	domainElement.textContent = "This page is unavailable";
	descriptionElement.textContent = "Available on websites only";
	statusElement.textContent = message;
	statusElement.classList.add("error");
}

async function initialise() {
	const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
	if (!tab?.url) {
		showUnavailable("Open an HTTP or HTTPS page to use NoJS.");
		return;
	}

	const url = new URL(tab.url);
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		showUnavailable("Safari does not allow extensions to change this page.");
		return;
	}

	activeTab = tab;
	hostname = normaliseHostname(url.hostname);
	domainElement.textContent = hostname;
	descriptionElement.textContent = `For ${hostname}`;

	const domains = await readDomains();
	toggle.checked = domains.includes(hostname);
	if (toggle.checked) {
		await replaceRules(domains);
	}
	toggle.disabled = false;
	statusElement.textContent = toggle.checked
		? "JavaScript is blocked on this domain."
		: "The page will reload when changed.";
}

toggle.addEventListener("change", async () => {
	const requestedState = toggle.checked;
	toggle.disabled = true;
	statusElement.classList.remove("error");
	statusElement.textContent = requestedState
		? "Blocking and reloading…"
		: "Allowing and reloading…";

	try {
		if (requestedState) {
			await ensureWebsiteAccess(hostname);
		}
		await saveDomainStatus(hostname, requestedState);

		browser.action
			.setBadgeText({
				tabId: activeTab.id,
				text: requestedState ? "OFF" : "",
			})
			.catch(() => undefined);
		if (requestedState) {
			browser.action
				.setBadgeBackgroundColor({
					tabId: activeTab.id,
					color: "#D94B3D",
				})
				.catch(() => undefined);
		}

		await browser.tabs.reload(activeTab.id, { bypassCache: true });
		window.close();
	} catch (error) {
		toggle.checked = !requestedState;
		toggle.disabled = false;
		statusElement.textContent =
			error?.message ?? "Could not update this domain.";
		statusElement.classList.add("error");
	}
});

initialise().catch((error) =>
	showUnavailable(error?.message ?? "Could not inspect this page."),
);
