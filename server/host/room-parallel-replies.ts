import type { BotRecord, GroupRecord, Message, Store } from "../store.ts";
import type { PersonName } from "../replies.ts";
import type { Coordinator, HandoffView } from "../coordinator.ts";
import type { RuntimeEvent } from "../contracts.ts";
import type { WireGroup } from "../../shared/wire.ts";
import { redactSecretsInText } from "../redact.ts";
import { GROUP_CONTEXT_MESSAGES, isRoomContextMessage } from "./room-transcript.ts";

export const PARALLEL_REPLY_RESTARTED = "Independent reply interrupted by an OpenMausBot restart. Review the saved reply and details before continuing.";

export function settleInterruptedParallelReplies(store: Pick<Store, "groups" | "messagesFor" | "patchMessage">): Array<{ groupId: string; threadId: string }> {
  const interrupted: Array<{ groupId: string; threadId: string }> = [];
  for (const group of store.groups) {
    for (const task of group.tasks ?? []) {
      const reply = task.parallelReply;
      if (!reply) continue;
      let pending = false;
      for (const message of store.messagesFor(reply.parentThreadId)) {
        if (message.kind !== "activity" || message.threadRef?.threadId !== task.threadId || !message.tool || message.tool.ok !== undefined) continue;
        pending = true;
        store.patchMessage(reply.parentThreadId, message.id, {
          tool: { ...message.tool, name: PARALLEL_REPLY_RESTARTED, ok: false },
        });
      }
      if (pending) interrupted.push({ groupId: group.id, threadId: task.threadId });
    }
  }
  return interrupted;
}

/** Load-time migration for persisted groups: drop transient parallel state and clamp the mode. Returns whether the record changed. */
export function migrateParallelGroupState(group: GroupRecord): boolean {
  delete group.activeResponders;
  for (const task of group.tasks ?? []) delete task.activeResponders;
  const responseMode = !group.dm && group.responseMode === "parallel" ? "parallel" : "sequential";
  if (group.responseMode === responseMode) return false;
  group.responseMode = responseMode;
  return true;
}

/** The lanes one parallel round opened for a room thread, held on the group turn operation. */
export interface ParallelLanes {
  botId: string;
  threadId: string;
}

/** What the parallel round needs of a group turn operation; index.ts's record satisfies this structurally. */
export interface ParallelOperation {
  id: string;
  threadId: string;
  botIds: Set<string>;
  cancelled: boolean;
  cancellation: { signal: AbortSignal };
  queuedQueueIds?: string[];
  parallelLanes?: Map<string, ParallelLanes>;
}

/** The member-turn outcome subset the round reads; index.ts's GroupMemberTurnOutcome is the same set. */
type MemberTurnOutcome =
  | "settled"
  | "provider_failed"
  | "dispatch_failed"
  | "spend_capped"
  | "stalled"
  | "timed_out"
  | "cancelled"
  | "busy"
  | "parked"
  | "unavailable";

export interface ParallelRepliesDeps<T extends ParallelOperation> {
  store: Store;
  broadcast: (payload: Record<string, unknown>) => void;
  coordinator: Pick<Coordinator, "awaitingAnswer" | "all" | "node">;
  bus: { subscribe: (listener: (event: RuntimeEvent) => void) => () => void };
  shouldIgnoreProviderEvent: (event: RuntimeEvent) => boolean;
  userNameFor: (threadId: string) => PersonName;
  publicGroupState: (record: GroupRecord) => WireGroup;
  speakersOf: (threadId: string) => { botId: string } | undefined;
  operations: (groupId: string) => Iterable<ParallelOperation>;
  turnTriggerFor: (threadId: string) => unknown;
  copyTurnTrigger: (from: string, to: string) => void;
  waitCapMs: () => number;
  beginGroupTurnOperation: (groupId: string, threadId: string, botIds?: string[]) => T;
  finishGroupTurnOperation: (groupId: string, operation: T) => void;
  waitForGroupMemberBot: (bot: BotRecord, operation: T, onWaiting: (detail: string) => void) => Promise<"ready" | "cancelled" | "unavailable" | "timed_out">;
  handshakeStarted: (operation: T) => void;
  handshakeSettled: (operation: T) => void;
  runMemberTurn: (args: {
    groupId: string;
    threadId: string;
    botId: string;
    onError: (message: string) => void;
    cancelled: () => boolean;
    operation: T;
    systemInstructions: string;
    onClaimed: () => void;
    contextMessages: Message[];
    contextUserName: PersonName;
    result: { replyText?: string; outcome?: MemberTurnOutcome; stopReason?: string | null };
  }) => Promise<boolean>;
}

const ENDED: ReadonlySet<HandoffView["status"]> = new Set(["completed", "failed", "cancelled"]);
type RoutedBy = NonNullable<Message["routedBy"]>;

export function createParallelReplies<T extends ParallelOperation>(deps: ParallelRepliesDeps<T>) {
  const { store, broadcast, coordinator } = deps;

    function respondersOf(groupId: string, threadId: string): NonNullable<WireGroup["activeResponders"]> {
    const responders: NonNullable<WireGroup["activeResponders"]> = [];
    for (const operation of deps.operations(groupId)) {
      if (operation.cancelled || operation.threadId !== threadId) continue;
      for (const lane of operation.parallelLanes?.values() ?? []) {
        const speaker = deps.speakersOf(lane.threadId);
        responders.push({ ...lane, state: coordinator.awaitingAnswer(lane.threadId) || (speaker && store.bot(lane.botId)?.activity === "waiting-on-you")
          ? "waiting-on-you" : speaker ? "running" : "queued" });
      }
    }
    return responders;
  }

  async function waitForChatRoomMember(
    operation: T,
    threadId: string,
    bot: BotRecord,
  ): Promise<"run" | "skip" | "stop"> {
    const waitTool = {
      name: `${bot.name} is finishing another conversation — will reply here when free`,
      spoken: `${bot.name} is finishing another conversation`,
    };
    let waitChip: Message | undefined;
    const availability = await deps.waitForGroupMemberBot(bot, operation, () => {
      waitChip = store.appendMessage(threadId, {
        role: "bot",
        kind: "activity",
        from: { botId: bot.id, name: bot.name, color: bot.color },
        tool: waitTool,
      });
    });
    switch (availability) {
      case "ready":
        if (waitChip) store.patchMessage(threadId, waitChip.id, { tool: { ...waitTool, ok: true } });
        operation.botIds.add(bot.id);
        return "run";
      case "cancelled":
        return "stop";
      case "unavailable":
        store.appendMessage(threadId, {
          role: "bot",
          kind: "activity",
          from: { botId: bot.id, name: bot.name, color: bot.color },
          tool: { name: `${bot.name} is no longer available — skipped this round`, ok: false },
        });
        return "skip";
      case "timed_out": {
        const minutes = Math.max(1, Math.round(deps.waitCapMs() / 60_000));
        const name =
          `${bot.name} stayed busy in another conversation for ${minutes} minute${minutes === 1 ? "" : "s"} — skipped this round`;
        if (waitChip) store.patchMessage(threadId, waitChip.id, { tool: { name, ok: false } });
        else {
          store.appendMessage(threadId, {
            role: "bot",
            kind: "activity",
            from: { botId: bot.id, name: bot.name, color: bot.color },
            tool: { name, ok: false },
          });
        }
        return "skip";
      }
    }
  }

    async function runRound(
    groupId: string,
    threadId: string,
    responders: BotRecord[],
    operation: T,
    source: Message,
    routedBy?: RoutedBy,
  ): Promise<void> {
    const group = store.group(groupId);
    if (!group || operation.cancelled) return;
    const history = store.messagesFor(threadId);
    const sourceIndex = history.findIndex(message => message.id === source.id);
    const contextMessages = structuredClone(history.filter((message, index) =>
      message.role !== "user" || index <= sourceIndex));
    const contextUserName = deps.userNameFor(threadId);
    store.pinGroupCwd(groupId, threadId);
    operation.botIds.clear();
    operation.parallelLanes = new Map();
    const prepared: Array<{
      bot: BotRecord;
      threadId: string;
      operation: T;
      progressId: string;
      replyId: string;
      contextIds: Set<string>;
    }> = [];
    for (const bot of responders) {
      const task = store.createGroupTask(groupId, `${bot.name} · parallel reply · ${source.text?.replace(/\s+/g, " ").slice(0, 32) ?? ""}`, false,
        { parentThreadId: threadId, messageId: source.id, botId: bot.id });
      if (!task) break;
      operation.parallelLanes.set(task.threadId, { botId: bot.id, threadId: task.threadId });
      const child = deps.beginGroupTurnOperation(groupId, task.threadId);
      child.queuedQueueIds = operation.queuedQueueIds;
      const copied = new Map<string, string>();
      for (const message of contextMessages.filter(isRoomContextMessage).slice(-GROUP_CONTEXT_MESSAGES)) {
        const clone = store.appendMessage(task.threadId, {
          role: message.role, kind: message.kind, text: message.text,
          from: message.from, sender: message.sender, via: message.via,
          attachments: message.attachments, digest: message.digest, roomRequest: message.roomRequest,
          peerPost: message.peerPost, webhookPost: message.webhookPost, reaction: message.reaction,
          replyToId: message.replyToId ? copied.get(message.replyToId) : undefined,
          ...(message.role === "user" ? { channelMode: "chat" as const } : {}),
        });
        copied.set(message.id, clone.id);
      }
        if (deps.turnTriggerFor(threadId)) deps.copyTurnTrigger(threadId, task.threadId);
      const from = { botId: bot.id, name: bot.name, color: bot.color };
      const progress = store.appendMessage(threadId, {
        role: "bot", kind: "activity", from,
        tool: { name: `${bot.name} — queued for an independent reply` },
        threadRef: { botId: groupId, threadId: task.threadId, title: task.title },
      });
      const reply = store.appendMessage(threadId, {
        role: "bot", kind: "text", text: "", from, replyToId: source.id,
        ...(routedBy ? { routedBy } : {}),
      });
      prepared.push({ bot, threadId: task.threadId, operation: child, progressId: progress.id, replyId: reply.id, contextIds: new Set(copied.values()) });
    }
    const publish = () => {
      const current = store.group(groupId);
      if (current) broadcast({ kind: "group", group: deps.publicGroupState(current) });
    };
    publish();
    await Promise.allSettled(prepared.map(async (lane) => {
      const result: { replyText?: string; outcome?: MemberTurnOutcome; stopReason?: string | null } = {};
      let failure: string | undefined;
      let childFinished = false;
      let root: HandoffView | undefined;
      let delta = "";
      let flushTimer: ReturnType<typeof setTimeout> | undefined;
      let lastText = "";
      let lastAttachments = "";
      let lastProgress = "";
      const cancelled = () => operation.cancelled || lane.operation.cancelled;
      const mirror = () => {
        flushTimer = undefined;
        if (!store.groupTaskByThread(groupId, threadId)) return;
        const replies = store.messagesFor(lane.threadId).filter(message =>
          !lane.contextIds.has(message.id) && message.role === "bot" && message.kind === "text" && message.from?.botId === lane.bot.id);
        const text = [...replies.map(message => message.text ?? "").filter(Boolean), delta].filter(Boolean).join("\n\n");
        const attachments = replies.flatMap(message => message.attachments ?? []);
        const attachmentKey = JSON.stringify(attachments);
        if (text === lastText && attachmentKey === lastAttachments) return;
        lastText = text;
        lastAttachments = attachmentKey;
        store.patchMessage(threadId, lane.replyId, { text, ...(attachments.length ? { attachments } : {}) });
      };
      const progress = () => {
        const speaker = deps.speakersOf(lane.threadId);
        const state = speaker
          ? store.bot(lane.bot.id)?.activity === "waiting-on-you" ? "needs your input — open reply details" : "replying independently"
          : coordinator.awaitingAnswer(lane.threadId) ? "needs your input — open reply details"
          : childFinished ? "waiting for teammate results" : "waiting for this member to become available";
        const name = `${lane.bot.name} — ${state}`;
        if (name === lastProgress || cancelled()) return;
        lastProgress = name;
        store.patchMessage(threadId, lane.progressId, { tool: { name } });
        publish();
      };
      const unsubscribeStore = store.onChange(change => {
        if ((change.type === "message" || change.type === "message.patch") && change.threadId === lane.threadId) {
          if (change.message.role === "bot" && change.message.kind === "text") {
            delta = "";
            if (flushTimer) clearTimeout(flushTimer);
            mirror();
          }
        }
        if ((change.type === "bot" && change.botId === lane.bot.id) || (change.type === "group" && change.groupId === groupId)) progress();
      });
      const unsubscribeRuntime = deps.bus.subscribe(event => {
        if (event.threadId !== lane.threadId || deps.shouldIgnoreProviderEvent(event) || cancelled()) return;
        if (event.type === "content.delta" && event.streamKind === "assistant_text") {
          delta += event.delta;
          if (!flushTimer) flushTimer = setTimeout(mirror, 80);
        }
      });
      try {
        const verdict = await waitForChatRoomMember(lane.operation, lane.threadId, lane.bot);
        if (cancelled() || verdict === "stop") return;
        if (verdict === "skip") {
          failure = `${lane.bot.name} could not become available for this reply`;
          return;
        }
        await deps.runMemberTurn({ groupId, threadId: lane.threadId, botId: lane.bot.id,
          onError: message => { failure = message; }, cancelled, operation: lane.operation,
          systemInstructions: "You are answering independently alongside other room members. Use the supplied conversation snapshot. Do not wait for their answers or summon other members with mentions; the person will receive each member's answer in the original conversation.",
          onClaimed: progress, contextMessages, contextUserName, result,
        });
        deps.finishGroupTurnOperation(groupId, lane.operation);
        childFinished = true;
        root = coordinator.all().find(node => node.groupId === groupId && node.threadId === lane.threadId && !node.parentId);
        while (root && !ENDED.has(root.status) && !cancelled()) {
          progress();
          await new Promise<void>(resolve => {
            const timer = setTimeout(done, 100);
            function done() {
              clearTimeout(timer);
              operation.cancellation.signal.removeEventListener("abort", done);
              resolve();
            }
            operation.cancellation.signal.addEventListener("abort", done, { once: true });
            if (operation.cancellation.signal.aborted) done();
          });
          root = coordinator.node(root.id);
        }
        if (root && root.status !== "completed" && !cancelled()) failure = root.result || root.outcomeDetail || root.status;
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      } finally {
        unsubscribeStore();
        unsubscribeRuntime();
        if (flushTimer) clearTimeout(flushTimer);
        delta = "";
        mirror();
        const ok = !cancelled() && !failure && (root ? root.status === "completed" : result.outcome === "settled") && Boolean(lastText.trim() || lastAttachments !== "[]");
        const detail = cancelled() ? "stopped" : ok ? "reply complete"
          : failure || result.stopReason || (result.outcome === "settled" ? "finished without a reply — open details" : result.outcome || "reply did not run");
        if (store.groupTaskByThread(groupId, threadId)) {
          store.patchMessage(threadId, lane.progressId, {
            tool: { name: `${lane.bot.name} — ${redactSecretsInText(detail).slice(0, 500)}`, ok },
          });
        }
        operation.parallelLanes?.delete(lane.threadId);
        if (!childFinished) deps.finishGroupTurnOperation(groupId, lane.operation);
        publish();
      }
    }));
  }

  return { respondersOf, waitForChatRoomMember, runRound };
}
