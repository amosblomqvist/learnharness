"use strict";
const $ = (id) => document.getElementById(id);
const setStatus = (text, kind = "") => {
	$("status").textContent = text;
	$("status").className = `status ${kind}`;
};
const busy = (on) => {
	for (const id of ["connect", "cancel", "local", "address"]) $(id).disabled = on;
};

window.lhConnect.current().then((current) => {
	if (current.mode === "remote") {
		$("address").value = current.url;
		$("mode").textContent = `Currently connected to ${current.url}. Enter a different address to switch servers.`;
		$("local").hidden = false;
	}
});

// An insecure-address warning is confirmed by pressing Connect again on the same address.
let warnedFor = null;

async function connect() {
	const address = $("address").value;
	busy(true);
	setStatus("Checking the server…");
	const result = await window.lhConnect.connect(address, warnedFor === address);
	busy(false);
	warnedFor = result.warning ? address : null;
	if (result.error) setStatus(result.error, "err");
	else if (result.warning) setStatus(result.warning, "warn");
	else setStatus("Connected. Restarting…", "ok");
}

$("connect").addEventListener("click", connect);
$("address").addEventListener("keydown", (e) => {
	if (e.key === "Enter") connect();
	if (e.key === "Escape") window.lhConnect.close();
});
$("cancel").addEventListener("click", () => window.lhConnect.close());
$("local").addEventListener("click", () => {
	busy(true);
	window.lhConnect.useLocal();
});
