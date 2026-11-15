// Channel instrumentation derived from c7cb8783's pre-navigation init script.
// Echo suppression is scoped to a synchronous dispatch, never a payload cache.
export function installAuditChannel() {
  const id = new URL(globalThis.location.href).searchParams.get("id");
  const state = {
    id, events: [], phases: [], collectionErrors: [],
    channelReady: false, closed: false, closedAt: null,
  };
  state.seal = () => {
    state.closed = true;
    state.closedAt ??= new Date().toISOString();
    return structuredClone({
      id, events: state.events, phases: state.phases,
      collectionErrors: state.collectionErrors,
      channelReady: state.channelReady, closed: true, closedAt: state.closedAt,
    });
  };
  Object.defineProperty(globalThis, "__PIRATE_STORY_AUDIT__", { value: state });
  const names = new Set([
    "storyFinished", "playFunctionThrewException", "unhandledErrorsWhilePlaying",
    "storyErrored", "storyThrewException",
  ]);
  let nextDispatch = 0;
  const dispatches = [];
  const attachedChannels = new Set();
  const record = (name, payload, dispatchId) => {
    if (state.closed || (name !== "storyRenderPhaseChanged" && !names.has(name))) return;
    const storyId = typeof payload?.storyId === "string" ? payload.storyId : id;
    if (name === "storyRenderPhaseChanged") {
      state.phases.push({
        dispatchId, storyId, phase: payload?.newPhase ?? null,
        width: globalThis.innerWidth, height: globalThis.innerHeight,
      });
    } else {
      let snapshot;
      try {
        snapshot = structuredClone(payload);
      } catch {
        state.collectionErrors.push("Channel payload snapshot failed: " + name);
        snapshot = null;
      }
      state.events.push({ dispatchId, name, storyId, payload: snapshot, at: Date.now() });
    }
  };
  let channel;
  const attach = (candidate) => {
    channel = candidate;
    if (!candidate || typeof candidate.on !== "function" || typeof candidate.emit !== "function") {
      return;
    }
    state.channelReady = true;
    if (attachedChannels.has(candidate)) return;
    attachedChannels.add(candidate);
    const emit = candidate.emit.bind(candidate);
    candidate.emit = (name, ...args) => {
      const dispatch = {
        id: ++nextDispatch, name, payload: args[0], echoSuppressed: false,
      };
      record(name, args[0], dispatch.id);
      dispatches.push(dispatch);
      try {
        return emit(name, ...args);
      } finally {
        dispatches.pop();
      }
    };
    for (const name of [...names, "storyRenderPhaseChanged"]) {
      candidate.on(name, (payload) => {
        const dispatch = dispatches.at(-1);
        if (dispatch && dispatch.name === name &&
          Object.is(dispatch.payload, payload) && !dispatch.echoSuppressed) {
          dispatch.echoSuppressed = true;
          return;
        }
        // Outside that emit's synchronous echo, this is a new observation.
        record(name, payload, ++nextDispatch);
      });
    }
  };
  Object.defineProperty(globalThis, "__STORYBOOK_ADDONS_CHANNEL__", {
    configurable: true, get: () => channel, set: attach,
  });
}
