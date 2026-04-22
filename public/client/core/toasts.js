function ensureToastRegion(documentRef = document) {
	let region = documentRef.querySelector("[data-zmail-toast-region]");
	if (region) {
		return region;
	}
	region = documentRef.createElement("div");
	region.setAttribute("data-zmail-toast-region", "");
	region.className = "toast-region";
	region.setAttribute("aria-live", "polite");
	documentRef.body.append(region);
	return region;
}

export function renderToast(toast, documentRef = document) {
	if (!toast?.text) {
		return null;
	}
	const region = ensureToastRegion(documentRef);
	const item = documentRef.createElement("div");
	const tone = ["success", "warning", "error"].includes(toast.tone)
		? toast.tone
		: "success";
	item.className = `toast toast-${tone}`;
	item.textContent = toast.text;
	region.append(item);
	window.setTimeout?.(() => item.remove(), 5000);
	return item;
}
