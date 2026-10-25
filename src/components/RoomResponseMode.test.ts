import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, Group } from "@/state/store";
import { setLocale } from "@/lib/i18n";

const fixture = vi.hoisted(() => ({ dispatch: vi.fn(), groups: [] as Group[] }));
vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(),
  useStore: () => ({ state: { bots: [], groups: fixture.groups }, dispatch: fixture.dispatch }),
}));
vi.mock("@/lib/thread-preferences", () => ({ useShowThreads: () => true }));

import { ParallelReplyParentLink, RoomResponseModeSelect } from "./RoomResponseMode";
import { RoomParallelReplies } from "./RoomQueueList";
import { Select } from "./Select";

type Node = ReactElement<Record<string, unknown> & { children?: ReactNode }>;
function nodes(value: ReactNode): Node[] {
  return Children.toArray(value).flatMap((child) => {
    if (!isValidElement(child)) return [];
    const node = child as Node;
    return [node, ...nodes(node.props.children)];
  });
}
const group = (patch: Partial<Group> = {}): Group => ({
  id: "room", threadId: "parent", name: "Team", memberIds: ["ada", "ben"],
  defaultResponder: { kind: "everyone" }, bulletin: "", unread: false, createdAt: 1, messages: [],
  ...patch,
});

beforeEach(() => { fixture.dispatch.mockReset(); fixture.groups = []; setLocale("en"); });
afterEach(() => setLocale("en"));

describe("reply mode", () => {
  it("keeps legacy rooms sequential and saves a deliberate switch to parallel", () => {
    const room = group();
    const markup = renderToStaticMarkup(createElement(RoomResponseModeSelect, { group: room }));
    expect(markup).toContain('<option value="sequential" selected="">Sequential replies</option>');
    const select = nodes(RoomResponseModeSelect({ group: room })).find((node) => node.type === Select)!;
    (select.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: "parallel" } });
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "patchGroup", groupId: "room", patch: { responseMode: "parallel" } });
  });

  it("explains independent context and prevents mode changes during an active round", () => {
    const markup = renderToStaticMarkup(createElement(RoomResponseModeSelect, { group: group({ responseMode: "parallel", working: true }) }));
    expect(markup).toContain("same starting context");
    expect(markup).toContain("handle approvals");
    expect(markup).toContain('disabled=""');
    setLocale("zh");
    const chinese = renderToStaticMarkup(createElement(RoomResponseModeSelect, { group: group({ responseMode: "parallel" }) }));
    expect(chinese).toContain("并行回复");
    expect(chinese).toContain("同一初始上下文");
  });
});

describe("parallel reply progress", () => {
  it("returns from a member's reply details to its original group question", () => {
    const room = group({ threadId: "ada-reply", tasks: [
      { threadId: "parent", title: "Question", createdAt: 1 },
      { threadId: "ada-reply", title: "Ada", createdAt: 2, parallelReply: { parentThreadId: "parent", messageId: "question", botId: "ada" } },
    ] });
    fixture.groups = [room];
    const button = nodes(ParallelReplyParentLink({ group: room })).find((node) => node.type === "button")!;
    (button.props.onClick as () => void)();
    expect(fixture.dispatch.mock.calls.map(([action]) => action)).toEqual([
      { type: "select", id: "room" },
      { type: "switchGroupTask", groupId: "room", threadId: "parent" },
      { type: "revealThread", threadId: "parent" },
    ]);
  });

  it("shows each member's state and opens an approval's exact group thread", () => {
    const room = group({
      activeResponders: [
        { botId: "ada", threadId: "ada-reply", state: "running" },
        { botId: "ben", threadId: "ben-reply", state: "waiting-on-you" },
      ],
      tasks: [
        { threadId: "parent", title: "Question", createdAt: 1 },
        { threadId: "ada-reply", title: "Ada", createdAt: 2 },
        { threadId: "ben-reply", title: "Ben", createdAt: 2 },
      ],
    });
    fixture.groups = [room];
    const members = [{ id: "ada", name: "Ada" }, { id: "ben", name: "Ben" }] as Bot[];
    const markup = renderToStaticMarkup(createElement(RoomParallelReplies, { group: room, members }));
    expect(markup).toContain("Ada · Replying");
    expect(markup).toContain("Ben · Needs your input");
    const buttons = nodes(RoomParallelReplies({ group: room, members })).filter((node) => node.type === "button");
    (buttons[1]!.props.onClick as () => void)();
    expect(fixture.dispatch.mock.calls.map(([action]) => action)).toEqual([
      { type: "select", id: "room" },
      { type: "switchGroupTask", groupId: "room", threadId: "ben-reply" },
      { type: "revealThread", threadId: "ben-reply" },
    ]);
  });

  it("clears settled progress and does not show another thread's replies", () => {
    const room = group({
      activeResponders: [{ botId: "ada", threadId: "ada-reply", state: "running" }],
      tasks: [{ threadId: "parent", title: "Question", createdAt: 1, activeResponders: [] }],
    });
    expect(renderToStaticMarkup(createElement(RoomParallelReplies, { group: room, members: [] }))).toBe("");
  });
});
