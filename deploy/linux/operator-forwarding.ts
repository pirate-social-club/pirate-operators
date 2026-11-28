/** Operator-facing SSH forwarding handoff. The paired setup listener is
 * loopback-only on the VPS; the operator reaches it from their own computer
 * through one explicit forwarding command. When the service runs inside an
 * SSH session its connection environment identifies the exact user, server
 * address and port the operator already uses, so the printed command is
 * genuinely copyable. Where an alias, jump host or NAT makes the server-side
 * view insufficient, the operator supplies their own known destination through
 * the environment and it is used verbatim after validation. Outside SSH the
 * template form is printed with visible substitution marks rather than a
 * guessed identity. */

export interface ForwardingHint {
  command: string;
  url: string;
  inferred: boolean;
}

const destinationPattern =
  /^([a-zA-Z0-9._-]+@)?(\[[0-9a-fA-F:]+\]|[a-zA-Z0-9][a-zA-Z0-9.-]{0,252})$/;

export function sshForwardingHint(
  port: number,
  env: Pick<
    NodeJS.ProcessEnv,
    "SSH_CONNECTION" | "USER" | "LOGNAME" | "PIRATE_SSH_DESTINATION" | "PIRATE_SSH_PORT"
  >,
): ForwardingHint {
  assertPort(port);
  const url = `http://127.0.0.1:${port}`;
  const forward = `-L ${port}:127.0.0.1:${port}`;
  const override = (env.PIRATE_SSH_DESTINATION ?? "").trim();
  if (override) {
    if (!destinationPattern.test(override))
      throw new Error("forwarding_destination_invalid");
    const overridePort = parsePort(env.PIRATE_SSH_PORT);
    return {
      command:
        `ssh ${forward}` +
        (overridePort && overridePort !== 22 ? ` -p ${overridePort}` : "") +
        ` ${override}`,
      url,
      inferred: true,
    };
  }
  const parts = (env.SSH_CONNECTION ?? "").trim().split(/\s+/);
  const serverAddress = parts.length === 4 ? parts[2]! : "";
  const serverPort = parts.length === 4 ? Number(parts[3]) : NaN;
  const user = (env.USER || env.LOGNAME || "").trim();
  const validUser = /^[a-z_][a-z0-9_-]{0,31}$/.test(user);
  const validServer = /^[0-9a-fA-F.:]{2,45}$/.test(serverAddress);
  if (validUser && validServer) {
    const host = serverAddress.includes(":")
      ? `[${serverAddress}]`
      : serverAddress;
    const portFlag =
      Number.isInteger(serverPort) && serverPort > 0 && serverPort !== 22
        ? ` -p ${serverPort}`
        : "";
    return {
      command: `ssh ${forward}${portFlag} ${user}@${host}`,
      url,
      inferred: true,
    };
  }
  return {
    command: `ssh ${forward} <user>@<this-server>`,
    url,
    inferred: false,
  };
}

export function forwardingOutput(
  hint: ForwardingHint,
  pairingCode: string,
): string {
  const lines = [
    "The private setup listener is ready on this server.",
    hint.inferred
      ? "Run this on your computer to forward it:"
      : "Run this on your computer, replacing the marked parts with how you reach this server:",
    "  " + hint.command,
    "Then open " + hint.url,
    "Private pairing code: " + pairingCode,
    "",
  ];
  return lines.join("\n");
}

function assertPort(port: number) {
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("forwarding_port_invalid");
}

function parsePort(value: string | undefined): number | null {
  if (!value) return null;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("forwarding_port_invalid");
  return port;
}
