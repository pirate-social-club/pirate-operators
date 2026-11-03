import { CONTEXT_ID, FROM, TO, scopeSignal } from "../harness/very/proof.ts";
import type { Provider } from "../harness/very/transport.ts";

// Deliberately invalid cryptography: only an injected fake verifier accepts it.
export function proofFixture(
  scope: string,
  binding: string,
  subject = "12345",
) {
  return JSON.stringify({
    proof: {
      pi_a: ["1", "2", "1"],
      pi_b: [
        ["1", "2"],
        ["3", "4"],
        ["1", "0"],
      ],
      pi_c: ["1", "2", "1"],
      protocol: "groth16",
      curve: "bn128",
    },
    publicSignals: [
      "3",
      CONTEXT_ID,
      subject,
      scopeSignal(scope),
      binding,
      FROM,
      "1",
      "0",
      FROM,
      TO,
    ],
  });
}

export function fakeProvider() {
  const requests: { scope: string; binding: string; key: Buffer }[] = [];
  let verifies = 0;
  const provider: Provider = {
    async open(_appId, scope, binding, key) {
      requests.push({ scope, binding, key });
      return { id: `fixture-${requests.length}` };
    },
    async poll(session) {
      const request = requests[Number(session.id.split("-")[1]) - 1];
      return proofFixture(
        request.scope,
        request.binding,
        request.scope === "1000001" ? "12345" : "67890",
      );
    },
    async verify() {
      verifies++;
    },
  };
  return {
    provider,
    requests,
    get verifies() {
      return verifies;
    },
  };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
