// Explicit wallet peer simulation for the browser fixture build only. No network or signing.
const address = `0x${"11".repeat(20)}`;
const increment = (key: string) =>
  localStorage.setItem(
    key,
    String(Number(localStorage.getItem(key) ?? "0") + 1),
  );
function externalWalletFocusDouble() {
  if (!localStorage.getItem("fixture_moss_focus")) return;
  const button = document.createElement("button");
  button.textContent = "Simulated MOSS control";
  button.style.cssText =
    "position:fixed;inset:0 auto auto 0;z-index:2147483647;pointer-events:auto;background:white;color:black;padding:16px";
  button.onclick = () => {
    increment("fixture_moss_focused");
    button.remove();
  };
  document.body.append(button);
  button.focus();
}
export const mega = {
  async initialise() {},
  async connect() {
    return { address, network: "testnet" };
  },
  async open() {
    increment("fixture_history");
  },
  async send(request: unknown) {
    increment("fixture_sends");
    localStorage.setItem("fixture_send_request", JSON.stringify(request));
    externalWalletFocusDouble();
    const status = localStorage.getItem("fixture_sdk_status") ?? "unknown";
    if (status === "unknown") throw Error("simulated lost wallet response");
    return { status };
  },
  async callContract(request: unknown) {
    increment("fixture_guard_calls");
    localStorage.setItem(
      "fixture_guard_request",
      JSON.stringify(request, (_key, value) =>
        typeof value === "bigint" ? value.toString() : value,
      ),
    );
    return {
      status: "approved",
      receipt: { chainId: 6343, transactionHash: `0x${"aa".repeat(32)}` },
    };
  },
};
