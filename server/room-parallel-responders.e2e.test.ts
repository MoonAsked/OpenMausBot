import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { connect, type Socket } from "node:net";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { launchVerificationServer, runControlOmb, verificationServerArgs, verificationServerEnvironment } from "../scripts/control-omb.ts";
import type { WireGroup } from "../shared/wire.ts";
import { waitForExit } from "./testing/cleanup.ts";

type Message = { id: string; role: string; kind: string; text?: string; tool?: { name?: string; ok?: boolean }; from?: { botId: string }; card?: { requestId?: string; answered?: string; dismissed?: boolean; expired?: boolean } };
type FixtureBot = { id: string; activeTaskId: string };
const POLL = { timeout: 30_000, interval: 100 };

async function launch() {
  const fixture = await launchVerificationServer();
  const { url, dataDir } = fixture.info;
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(url + path, {
      method,
      headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json() as any;
    expect(response.ok, `${method} ${path} ${response.status}: ${JSON.stringify(value)}`).toBe(true);
    return value;
  };
  const control = (...args: string[]) => runControlOmb([...args, "--url", url]) as Promise<any>;
  const modes = join(dataDir, "parallel-modes.json");
  writeFileSync(modes, "{}");
  const wrapper = join(dataDir, "fake-parallel-claude.mjs");
  writeFileSync(wrapper, [
    "#!/usr/bin/env node",
    'import { readFileSync } from "node:fs";',
    'import { join } from "node:path";',
    'const at = process.argv.indexOf("--mcp-config");',
    'const agents = at < 0 ? {} : JSON.parse(readFileSync(process.argv[at + 1], "utf8")).mcpServers?.agents?.env ?? {};',
    'const thread = agents.OMB_THREAD_ID ?? "probe";',
    'const bot = agents.OMB_BOT_ID ?? "probe";',
    `const modes = JSON.parse(readFileSync(${JSON.stringify(modes)}, "utf8"));`,
    "const plan = modes[`${thread}:${bot}`] ?? modes[thread] ?? modes[bot] ?? {};",
    'process.env.FAKE_CLAUDE_MODE = plan.mode ?? "happy";',
    'process.env.FAKE_CLAUDE_TOOL_CALLS = "[]";',
    "Object.assign(process.env, plan.env ?? {});",
    `process.env.FAKE_CLAUDE_DUMP = join(${JSON.stringify(dataDir)}, \`provider-\${bot}.json\`);`,
    `await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/testing/fake-claude-cli.ts")).href)});`,
  ].join("\n"), { mode: 0o700 });
  await api("PATCH", "/api/instances/claude", { cli: wrapper });
  const play = (key: string, mode: string, env: Record<string, string> = {}) => {
    const plan = JSON.parse(readFileSync(modes, "utf8"));
    writeFileSync(modes, JSON.stringify({ ...plan, [key]: { mode, env } }));
  };
  const gate = (name: string) => join(dataDir, `${name}.gate`);
  const release = (path: string) => writeFileSync(path, "finish");
  const dump = (botId: string) => {
    try { return JSON.parse(readFileSync(join(dataDir, `provider-${botId}.json`), "utf8")); }
    catch { return undefined; }
  };
  const providerThread = (botId: string): string | undefined => dump(botId)?.mcpConfig?.mcpServers?.agents?.env?.OMB_THREAD_ID;
  const prompt = (botId: string): string => JSON.stringify(dump(botId)?.prompt ?? "");
  const fleet = async () => await api("GET", "/api/bots?messages=0") as { bots: Array<{ id: string; busy?: boolean }>; groups: WireGroup[] };
  const room = async (id: string) => (await fleet()).groups.find((group) => group.id === id)!;
  const task = async (roomId: string, threadId: string) => (await room(roomId)).tasks?.find((item) => item.threadId === threadId);
  const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).messages as Message[];
  const replied = async (threadId: string, botId: string, text?: string) => (await messages(threadId)).some((message) =>
    message.role === "bot" && message.kind === "text" && message.from?.botId === botId && (!text || message.text?.includes(text)));
  const newBot = async (name: string): Promise<FixtureBot> => (await control("new-bot", "--name", name)).bot;
  const newRoom = async (name: string, members: FixtureBot[], mode: boolean | "parallel" | "broadcast" = false, responder: Record<string, unknown> = { kind: "everyone" }) => {
    const channel = (await control("new-channel", "--name", name, "--members", members.map((bot) => bot.id).join(","))).channel;
    await api("PATCH", `/api/groups/${channel.id}`, { defaultResponder: responder, ...(mode ? { responseMode: mode === true ? "parallel" : mode } : {}) });
    return { id: channel.id as string, threadId: channel.activeTaskId as string };
  };
  const send = (target: { id: string; threadId: string }, text: string) => api("POST", `/api/groups/${target.id}/messages`, { text, threadId: target.threadId });
  const stop = (target: { id: string; threadId: string }) => api("POST", `/api/groups/${target.id}/interrupt`, { threadId: target.threadId });
  const idle = async (target: { id: string; threadId: string }) => {
    await expect.poll(async () => Boolean((await task(target.id, target.threadId))?.working), POLL).toBe(false);
  };
  const evidence = (label: string, value: unknown) => {
    const dir = process.env.OMB_PARALLEL_EVIDENCE_DIR;
    if (!dir) return;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${label}.json`), JSON.stringify({ fixture: fixture.info, value }, null, 2));
  };
  let currentChild = fixture.child;
  const restart = async () => {
    await waitForExit(currentChild, { signal: "SIGKILL" });
    const env = verificationServerEnvironment({}, dataDir, Number(new URL(url).port));
    const log = openSync(fixture.info.logPath, "a");
    try {
      currentChild = spawn(process.execPath, verificationServerArgs(env), { cwd: process.cwd(), env, stdio: ["ignore", log, log] });
    } finally {
      closeSync(log);
    }
    await expect.poll(async () => {
      if (currentChild.exitCode !== null || currentChild.signalCode !== null) throw new Error(`Restart exited; see ${fixture.info.logPath}`);
      try { return (await fetch(url + "/api/health")).ok; } catch { return false; }
    }, POLL).toBe(true);
  };
  const close = async () => {
    if (currentChild !== fixture.child) await waitForExit(currentChild, { signal: "SIGTERM" });
    await fixture.close();
  };
  return { ...fixture, close, restart, api, play, gate, release, dump, providerThread, prompt, fleet, room, task, messages, replied, newBot, newRoom, send, stop, idle, evidence };
}

describe.skipIf(process.platform === "win32")("parallel room responders", () => {
  it("overlaps isolated member turns, stops the whole round alone, and completes a later round", async () => {
    const f = await launch();
    try {
      const xena = await f.newBot("Xena");
      const yuri = await f.newBot("Yuri");
      const zora = await f.newBot("Zora");
      const gates = [f.gate("xena"), f.gate("yuri"), f.gate("zora")];
      for (const [index, bot] of [xena, yuri, zora].entries()) f.play(bot.id, "hang", { FAKE_CLAUDE_FINISH_GATE: gates[index]! });
      const pair = await f.newRoom("Parallel pair", [xena, yuri], true);
      const other = await f.newRoom("Unrelated room", [zora]);
      await f.send(other, "Stay active until released");
      await f.send(pair, "Compare two independent solutions");
      await expect.poll(async () => {
        const active = (await f.task(pair.id, pair.threadId))?.activeResponders ?? [];
        return active.filter((member) => member.state === "running").map((member) => member.botId).sort();
      }, POLL).toEqual([xena.id, yuri.id].sort());
      await expect.poll(() => Boolean(f.providerThread(xena.id) && f.providerThread(yuri.id) && f.providerThread(zora.id)), POLL).toBe(true);
      expect(f.providerThread(xena.id)).not.toBe(f.providerThread(yuri.id));
      expect(f.providerThread(xena.id)).not.toBe(pair.threadId);
      expect(f.providerThread(yuri.id)).not.toBe(pair.threadId);
      const running = await f.fleet();
      expect(running.bots.filter((bot) => [xena.id, yuri.id, zora.id].includes(bot.id)).every((bot) => bot.busy)).toBe(true);
      expect(gates.every((gate) => !existsSync(gate))).toBe(true);
      f.evidence("overlapping-provider-turns", { fleet: running, providerThreads: [xena, yuri, zora].map((bot) => ({ botId: bot.id, threadId: f.providerThread(bot.id), pid: f.dump(bot.id)?.pid })) });

      await f.stop(pair);
      await f.idle(pair);
      await expect.poll(async () => (await f.fleet()).bots.filter((bot) => [xena.id, yuri.id].includes(bot.id)).every((bot) => !bot.busy), POLL).toBe(true);
      expect(await f.task(other.id, other.threadId)).toMatchObject({ working: true, busyBotId: zora.id });
      expect((await f.task(pair.id, pair.threadId))?.activeResponders ?? []).toEqual([]);
      f.evidence("scoped-stop", { pair: await f.room(pair.id), other: await f.room(other.id), messages: await f.messages(pair.threadId) });

      for (const gate of gates) f.release(gate);
      await f.idle(other);
      await f.send(pair, "A fresh independent round after Stop");
      await expect.poll(() => f.replied(pair.threadId, xena.id, "fixture turn completed"), POLL).toBe(true);
      await expect.poll(() => f.replied(pair.threadId, yuri.id, "fixture turn completed"), POLL).toBe(true);
      await f.idle(pair);
      const finished = await f.messages(pair.threadId);
      for (const bot of [xena, yuri]) expect(finished.filter((message) => message.from?.botId === bot.id && message.kind === "text" && message.text?.includes("fixture turn completed"))).toHaveLength(1);
      f.evidence("completed-round", { room: await f.room(pair.id), messages: finished });
    } finally {
      await f.close();
    }
  }, 150_000);

  it("starts a free later member while the first is busy and preserves the round's initial context", async () => {
    const f = await launch();
    try {
      const xena = await f.newBot("Xena");
      const yuri = await f.newBot("Yuri");
      const occupied = await f.newRoom("Xena occupied", [xena]);
      const pair = await f.newRoom("Independent context", [xena, yuri], true);
      const gate = f.gate("occupied");
      f.play(`${occupied.threadId}:${xena.id}`, "hang", { FAKE_CLAUDE_FINISH_GATE: gate });
      f.play(xena.id, "happy", { FAKE_CLAUDE_REPLIES: JSON.stringify(["XENA_INDEPENDENT_RESULT"]) });
      f.play(yuri.id, "happy", { FAKE_CLAUDE_REPLIES: JSON.stringify(["YURI_SAME_ROUND_SECRET_74a19"]) });
      await f.send(occupied, "Do unrelated occupied work");
      await expect.poll(async () => (await f.task(occupied.id, occupied.threadId))?.busyBotId, POLL).toBe(xena.id);
      await f.send(pair, "INITIAL_PARALLEL_QUESTION_26b95");
      await expect.poll(() => f.replied(pair.threadId, yuri.id, "YURI_SAME_ROUND_SECRET_74a19"), POLL).toBe(true);
      expect(await f.task(occupied.id, occupied.threadId)).toMatchObject({ working: true, busyBotId: xena.id });
      expect((await f.task(pair.id, pair.threadId))?.working).toBe(true);
      expect((await f.task(pair.id, pair.threadId))?.activeResponders).toContainEqual(expect.objectContaining({ botId: xena.id, state: "queued" }));
      expect(f.providerThread(xena.id)).toBe(occupied.threadId);
      const freeMemberPrompt = f.prompt(yuri.id);
      f.release(gate);
      await expect.poll(() => f.replied(pair.threadId, xena.id, "XENA_INDEPENDENT_RESULT"), POLL).toBe(true);
      await f.idle(pair);
      expect(f.providerThread(xena.id)).not.toBe(occupied.threadId);
      for (const prompt of [freeMemberPrompt, f.prompt(xena.id)]) {
        expect(prompt).toContain("INITIAL_PARALLEL_QUESTION_26b95");
        expect(prompt).not.toContain("YURI_SAME_ROUND_SECRET_74a19");
        expect(prompt).not.toContain("XENA_INDEPENDENT_RESULT");
      }
      f.evidence("busy-first-fixed-context", { room: await f.room(pair.id), messages: await f.messages(pair.threadId), prompts: { xena: f.prompt(xena.id), yuri: freeMemberPrompt } });
    } finally {
      await f.close();
    }
  }, 120_000);

  it("keeps sequential discussion as the default", async () => {
    const f = await launch();
    try {
      const xena = await f.newBot("Xena");
      const yuri = await f.newBot("Yuri");
      const pair = await f.newRoom("Sequential discussion", [xena, yuri]);
      const gate = f.gate("first-speaker");
      f.play(xena.id, "hang", { FAKE_CLAUDE_FINISH_GATE: gate });
      f.play(yuri.id, "happy", { FAKE_CLAUDE_REPLIES: JSON.stringify(["YURI_SEQUENTIAL_RESULT"]) });
      expect((await f.room(pair.id)).responseMode).toBe("sequential");
      await f.send(pair, "Discuss this sequentially");
      await expect.poll(async () => (await f.task(pair.id, pair.threadId))?.busyBotId, POLL).toBe(xena.id);
      expect(f.providerThread(yuri.id)).toBeUndefined();
      f.release(gate);
      await expect.poll(() => f.replied(pair.threadId, yuri.id, "YURI_SEQUENTIAL_RESULT"), POLL).toBe(true);
      await f.idle(pair);
      expect(f.providerThread(xena.id)).toBe(pair.threadId);
      expect(f.providerThread(yuri.id)).toBe(pair.threadId);
      expect(f.prompt(yuri.id)).toContain("fixture turn completed");
      f.evidence("sequential-default", { room: await f.room(pair.id), messages: await f.messages(pair.threadId), secondPrompt: f.prompt(yuri.id) });
    } finally {
      await f.close();
    }
  }, 90_000);

  it("broadcasts a message that names one member, and that member may pass silently", async () => {
    const f = await launch();
    try {
      const xena = await f.newBot("Xena");
      const yuri = await f.newBot("Yuri");
      const pair = await f.newRoom("Broadcast room", [xena, yuri], "broadcast", { kind: "member", botId: xena.id });
      f.play(xena.id, "happy", { FAKE_CLAUDE_REPLIES: JSON.stringify(["[skip]"]) });
      f.play(yuri.id, "happy", { FAKE_CLAUDE_REPLIES: JSON.stringify(["YURI_ANSWERED_EVERYONE_READS"]) });
      expect((await f.room(pair.id)).responseMode).toBe("broadcast");
      // The message names only Xena and the default responder is Xena alone; broadcast still reaches both members.
      await f.send(pair, "@Xena this one is for you");
      await expect.poll(async () => Boolean(f.providerThread(xena.id) && f.providerThread(yuri.id)), POLL).toBe(true);
      expect(f.providerThread(xena.id)).not.toBe(f.providerThread(yuri.id));
      expect(f.providerThread(xena.id)).not.toBe(pair.threadId);
      await expect.poll(() => f.replied(pair.threadId, yuri.id, "YURI_ANSWERED_EVERYONE_READS"), POLL).toBe(true);
      await f.idle(pair);
      const messages = await f.messages(pair.threadId);
      expect(messages.some((message) => message.from?.botId === xena.id && message.kind === "text" && (message.text ?? "").trim() !== "")).toBe(false);
      expect(messages.some((message) => message.from?.botId === xena.id && message.tool?.ok === true && (message.tool.name ?? "").includes("passed"))).toBe(true);
      expect(messages.some((message) => message.from?.botId === xena.id && message.tool?.ok === false)).toBe(false);
      expect((await f.task(pair.id, pair.threadId))?.activeResponders ?? []).toEqual([]);
      f.evidence("broadcast-self-select", { room: await f.room(pair.id), messages });
    } finally {
      await f.close();
    }
  }, 90_000);

  it("broadcasts to every member when the room only answers mentions and nobody is named", async () => {
    const f = await launch();
    try {
      const xena = await f.newBot("Xena");
      const yuri = await f.newBot("Yuri");
      const pair = await f.newRoom("Broadcast unaddressed", [xena, yuri], "broadcast", { kind: "mentions" });
      f.play(xena.id, "happy", { FAKE_CLAUDE_REPLIES: JSON.stringify(["[SKIP]"]) });
      f.play(yuri.id, "happy", { FAKE_CLAUDE_REPLIES: JSON.stringify(["YURI_ANSWERED_UNADDRESSED"]) });
      await f.send(pair, "Nobody is mentioned and this room only answers mentions");
      await expect.poll(async () => Boolean(f.providerThread(xena.id) && f.providerThread(yuri.id)), POLL).toBe(true);
      await expect.poll(() => f.replied(pair.threadId, yuri.id, "YURI_ANSWERED_UNADDRESSED"), POLL).toBe(true);
      await f.idle(pair);
      const messages = await f.messages(pair.threadId);
      expect(messages.some((message) => message.from?.botId === xena.id && message.kind === "text" && (message.text ?? "").trim() !== "")).toBe(false);
      expect(messages.some((message) => message.from?.botId === xena.id && message.tool?.ok === true && (message.tool.name ?? "").includes("passed"))).toBe(true);
      f.evidence("broadcast-unaddressed", { room: await f.room(pair.id), messages });
    } finally {
      await f.close();
    }
  }, 90_000);

  it("keeps a member-details follow-up with that member alone in a broadcast room", async () => {
    const f = await launch();
    try {
      const xena = await f.newBot("Xena");
      const yuri = await f.newBot("Yuri");
      const pair = await f.newRoom("Broadcast follow-up", [xena, yuri], "broadcast");
      f.play(xena.id, "happy", { FAKE_CLAUDE_REPLIES: JSON.stringify(["FIRST_ROUND_ANSWER"]) });
      f.play(yuri.id, "happy", { FAKE_CLAUDE_REPLIES: JSON.stringify(["YURI_FIRST_ROUND"]) });
      await f.send(pair, "Everyone answers once");
      await expect.poll(() => f.replied(pair.threadId, xena.id, "FIRST_ROUND_ANSWER"), POLL).toBe(true);
      await expect.poll(() => f.replied(pair.threadId, yuri.id, "YURI_FIRST_ROUND"), POLL).toBe(true);
      await f.idle(pair);
      const lane = (await f.room(pair.id)).tasks?.find(task => task.parallelReply?.botId === xena.id && task.threadId !== pair.threadId);
      expect(lane?.threadId).toBeTruthy();
      const laneThread = lane!.threadId!;
      const before = (await f.room(pair.id)).tasks?.length ?? 0;
      const follow = await f.send({ id: pair.id, threadId: laneThread }, "Follow up in the member's details");
      const laneReplies = async () => (await f.messages(laneThread)).filter(message =>
        message.role === "bot" && message.kind === "text" && message.from?.botId === xena.id);
      await expect.poll(async () => (await laneReplies()).length >= 2, POLL).toBe(true);
      await f.idle({ id: pair.id, threadId: laneThread });
      const room = await f.room(pair.id);
      expect(room.tasks?.length ?? 0).toBe(before);
      expect(room.tasks?.filter(task => task.parallelReply?.messageId === follow.message.id) ?? []).toEqual([]);
      expect((await f.messages(laneThread)).some(message => message.from?.botId === yuri.id)).toBe(false);
      f.evidence("broadcast-follow-up-stays-single", { room, laneThread });
    } finally {
      await f.close();
    }
  }, 90_000);

  it("still broadcasts when the default responder is held and nobody is mentioned", async () => {
    const f = await launch();
    try {
      const xena = await f.newBot("Xena");
      const yuri = await f.newBot("Yuri");
      const pair = await f.newRoom("Broadcast held default", [xena, yuri], "broadcast", { kind: "member", botId: xena.id });
      await f.api("POST", `/api/groups/${pair.id}/holds`, { botId: xena.id, held: true });
      const xenaBefore = f.providerThread(xena.id);
      f.play(yuri.id, "happy", { FAKE_CLAUDE_REPLIES: JSON.stringify(["YURI_ANSWERED_DESPITE_HELD_DEFAULT"]) });
      // No mention in the text: the hold on the default responder stays, and the broadcast still reaches everyone else.
      await f.send(pair, "Nobody in particular is addressed here");
      await expect.poll(() => f.replied(pair.threadId, yuri.id, "YURI_ANSWERED_DESPITE_HELD_DEFAULT"), POLL).toBe(true);
      await f.idle(pair);
      expect(f.providerThread(xena.id)).toBe(xenaBefore);
      expect(((await f.room(pair.id)).tasks ?? []).some(task => task.parallelReply?.botId === xena.id)).toBe(false);
      f.evidence("broadcast-held-default", { room: await f.room(pair.id) });
    } finally {
      await f.close();
    }
  }, 90_000);

  it("says so when every member passes, tolerating decorated skip markers", async () => {
    const f = await launch();
    try {
      const xena = await f.newBot("Xena");
      const yuri = await f.newBot("Yuri");
      const pair = await f.newRoom("Broadcast all pass", [xena, yuri], "broadcast");
      f.play(xena.id, "happy", { FAKE_CLAUDE_REPLIES: JSON.stringify(["`[skip]` 这条不是给我的"]) });
      f.play(yuri.id, "happy", { FAKE_CLAUDE_REPLIES: JSON.stringify(["看过之后我决定 [SKIP]。"]) });
      await f.send(pair, "This one is for neither of you");
      await f.idle(pair);
      const messages = await f.messages(pair.threadId);
      expect(messages.some((message) => message.role === "bot" && message.kind === "text" && (message.text ?? "").trim() !== "")).toBe(false);
      expect(messages.some((message) => message.from?.botId === xena.id && message.tool?.ok === true && (message.tool.name ?? "").includes("passed"))).toBe(true);
      expect(messages.some((message) => message.from?.botId === yuri.id && message.tool?.ok === true && (message.tool.name ?? "").includes("passed"))).toBe(true);
      expect(messages.some((message) => message.tool?.ok === true && (message.tool.name ?? "").includes("Every member read this message and passed"))).toBe(true);
      expect(messages.some((message) => message.tool?.ok === false)).toBe(false);
      f.evidence("broadcast-all-pass", { room: await f.room(pair.id), messages });
    } finally {
      await f.close();
    }
  }, 90_000);

  it("shows one member's provider failure while another member completes", async () => {
    const f = await launch();
    try {
      const xena = await f.newBot("Xena");
      const yuri = await f.newBot("Yuri");
      const pair = await f.newRoom("Independent failures", [xena, yuri], true);
      f.play(xena.id, "not-logged-in");
      f.play(yuri.id, "happy", { FAKE_CLAUDE_REPLIES: JSON.stringify(["YURI_SUCCEEDED_DESPITE_PEER_FAILURE"]) });
      await f.send(pair, "Each member should answer independently");
      await expect.poll(() => f.replied(pair.threadId, yuri.id, "YURI_SUCCEEDED_DESPITE_PEER_FAILURE"), POLL).toBe(true);
      await f.idle(pair);
      const messages = await f.messages(pair.threadId);
      expect(messages.some((message) => message.from?.botId === xena.id && message.tool?.ok === false)).toBe(true);
      expect((await f.task(pair.id, pair.threadId))?.activeResponders ?? []).toEqual([]);
      f.evidence("isolated-provider-failure", { room: await f.room(pair.id), messages });
    } finally {
      await f.close();
    }
  }, 90_000);

  it("mirrors partial responses without duplicating text at provider item boundaries", async () => {
    const f = await launch();
    try {
      const xena = await f.newBot("Xena");
      const yuri = await f.newBot("Yuri");
      const pair = await f.newRoom("Parallel streaming", [xena, yuri], true);
      const replies = new Map<string, string[]>();
      for (const [index, bot] of [xena, yuri].entries()) {
        const parts = [
          `${index === 0 ? "XENA" : "YURI"}_FIRST_${"abcdefghij".repeat(12)}`,
          `${index === 0 ? "XENA" : "YURI"}_SECOND_${"klmnopqrst".repeat(12)}`,
        ];
        replies.set(bot.id, parts);
        f.play(bot.id, "happy", { FAKE_CLAUDE_REPLIES: JSON.stringify([parts]), FAKE_CLAUDE_STREAM_CADENCE: "5:40" });
      }
      await f.send(pair, "Stream two independent answers with multiple items");
      const samples = new Map<string, string[]>([...replies.keys()].map((id) => [id, []]));
      await expect.poll(async () => {
        const messages = await f.messages(pair.threadId);
        for (const botId of replies.keys()) {
          const text = messages.filter((message) => message.kind === "text" && message.from?.botId === botId)
            .map((message) => message.text ?? "").join("\n\n");
          if (text) samples.get(botId)!.push(text);
        }
        return [...replies].every(([botId, parts]) => samples.get(botId)?.at(-1) === parts.join("\n\n")) &&
          !(await f.task(pair.id, pair.threadId))?.working;
      }, { ...POLL, interval: 25 }).toBe(true);
      for (const [botId, parts] of replies) {
        const expected = parts.join("\n\n");
        const observed = samples.get(botId)!;
        expect(observed.some((text) => text.length > 0 && text.length < parts[0]!.length)).toBe(true);
        expect(observed.some((text) => text.length > parts[0]!.length && text.length < expected.length)).toBe(true);
        for (const [index, text] of observed.entries()) {
          expect(expected.startsWith(text), `unexpected partial response: ${text}`).toBe(true);
          if (index > 0) expect(text.length).toBeGreaterThanOrEqual(observed[index - 1]!.length);
        }
        expect((await f.messages(pair.threadId)).filter((message) => message.kind === "text" && message.from?.botId === botId)).toHaveLength(1);
      }
      f.evidence("streaming-item-boundaries", { messages: await f.messages(pair.threadId), samples: Object.fromEntries(samples) });
    } finally {
      await f.close();
    }
  }, 90_000);

  it("isolates simultaneous approvals and holding one member leaves the other waiting", async () => {
    const f = await launch();
    const sockets: Socket[] = [];
    try {
      const xena = await f.newBot("Xena");
      const yuri = await f.newBot("Yuri");
      const pair = await f.newRoom("Independent approvals", [xena, yuri], true);
      for (const bot of [xena, yuri]) {
        await f.api("PATCH", `/api/bots/${bot.id}`, { approvalMode: "ask" });
        f.play(bot.id, "hang");
      }
      await f.send(pair, "Wait for a separate approval from each member");
      await expect.poll(() => Boolean(f.providerThread(xena.id) && f.providerThread(yuri.id)), POLL).toBe(true);
      const answers = new Map<string, any[]>();
      for (const bot of [xena, yuri]) {
        const path = f.dump(bot.id).mcpConfig.mcpServers.ogb.args.at(-1) as string;
        const socket = connect(path);
        sockets.push(socket);
        await new Promise<void>((resolve, reject) => {
          socket.once("connect", resolve);
          socket.once("error", reject);
        });
        const received: any[] = [];
        answers.set(bot.id, received);
        let buffer = "";
        socket.on("data", (chunk) => {
          buffer += chunk.toString();
          let end: number;
          while ((end = buffer.indexOf("\n")) >= 0) {
            received.push(JSON.parse(buffer.slice(0, end)));
            buffer = buffer.slice(end + 1);
          }
        });
        socket.write(JSON.stringify({ t: "ask", id: "same-request-id", kind: "permission", tool: "Bash", input: { command: `echo ${bot.id}` } }) + "\n");
      }
      await expect.poll(async () => (await f.task(pair.id, pair.threadId))?.activeResponders?.filter((member) => member.state === "waiting-on-you").length, POLL).toBe(2);
      expect([...answers.values()].flat()).toEqual([]);
      f.evidence("parallel-approval-waits", { room: await f.room(pair.id), messages: await f.messages(pair.threadId) });
      await f.api("POST", `/api/groups/${pair.id}/holds`, { botId: xena.id, held: true });
      await expect.poll(async () => (await f.task(pair.id, pair.threadId))?.activeResponders?.map((member) => ({ botId: member.botId, state: member.state })), POLL)
        .toEqual([{ botId: yuri.id, state: "waiting-on-you" }]);
      expect(answers.get(yuri.id)).toEqual([]);
      expect((await f.fleet()).bots.find((bot) => bot.id === xena.id)?.busy).toBe(false);
      await f.stop(pair);
      await f.idle(pair);
      await expect.poll(async () => (await f.fleet()).bots.filter((bot) => [xena.id, yuri.id].includes(bot.id)).every((bot) => !bot.busy), POLL).toBe(true);
      for (const bot of [xena, yuri]) {
        const cards = (await f.messages(f.providerThread(bot.id)!)).filter((message) => message.kind === "options");
        expect(cards.length).toBeGreaterThan(0);
        expect(cards.filter((message) => !message.card?.answered && !message.card?.dismissed && !message.card?.expired)).toEqual([]);
      }
      f.evidence("hold-and-stop-approvals", { room: await f.room(pair.id), messages: await f.messages(pair.threadId), answers: Object.fromEntries(answers) });
    } finally {
      for (const socket of sockets) socket.destroy();
      await f.close();
    }
  }, 90_000);

  it("retains the mode and marks unfinished parent replies after a server restart", async () => {
    const f = await launch();
    try {
      const xena = await f.newBot("Xena");
      const yuri = await f.newBot("Yuri");
      const pair = await f.newRoom("Restarted independent replies", [xena, yuri], true);
      for (const bot of [xena, yuri]) f.play(bot.id, "hang");
      await f.send(pair, "Retain this unfinished independent round");
      await expect.poll(async () => (await f.task(pair.id, pair.threadId))?.activeResponders?.filter((member) => member.state === "running").length, POLL).toBe(2);
      const before = await f.room(pair.id);
      await f.restart();
      expect((await f.room(pair.id)).responseMode).toBe("parallel");
      expect((await f.task(pair.id, pair.threadId))?.activeResponders ?? []).toEqual([]);
      await f.idle(pair);
      const messages = await f.messages(pair.threadId);
      for (const bot of [xena, yuri]) {
        expect(messages.some((message) => message.from?.botId === bot.id && message.tool?.ok === false && /restart|interrupted/i.test(message.tool.name ?? ""))).toBe(true);
      }
      expect((await f.room(pair.id)).tasks?.map((task) => task.threadId).sort()).toEqual(before.tasks?.map((task) => task.threadId).sort());
      f.evidence("restart-interrupted-replies", { before, after: await f.room(pair.id), messages });
      for (const bot of [xena, yuri]) f.play(bot.id, "happy", { FAKE_CLAUDE_REPLIES: JSON.stringify(["Fresh reply after server restart"]) });
      await f.send(pair, "Start a new round after restart");
      for (const bot of [xena, yuri]) await expect.poll(() => f.replied(pair.threadId, bot.id, "Fresh reply after server restart"), POLL).toBe(true);
      await f.idle(pair);
    } finally {
      await f.close();
    }
  }, 90_000);

  it.each(["complete", "stop"] as const)("keeps a delegated lane attached to its parent through %s", async (action) => {
    const f = await launch();
    try {
      const xena = await f.newBot("Xena");
      const yuri = await f.newBot("Yuri");
      const zora = await f.newBot("Zora");
      const pair = await f.newRoom("Parallel delegated work", [xena, yuri, zora], true);
      const gate = f.gate("delegated-work");
      const ready = f.gate("delegated-work-started");
      const planFile = join(f.info.dataDir, "parallel-delegation.json");
      writeFileSync(planFile, JSON.stringify({
        [xena.id]: {
          byPrompt: [{ promptIncludes: "LANE_FOLLOWUP_ONLY", plan: { reply: "XENA_FOLLOWUP_ONLY", resumeReply: "XENA_FOLLOWUP_ONLY" } }],
          steps: [{ arguments: { bot_ids: [zora.id], message: "HELPER_WORK_FOR_XENA", request_key: "parallel-helper" } }],
          reply: "XENA_WAITING_FOR_HELPER", resumeReply: "XENA_FINAL_AFTER_HELPER",
        },
        [yuri.id]: { reply: "YURI_INDEPENDENT_DONE" },
        [zora.id]: { gateFile: gate, readyFile: ready, reply: "ZORA_HELPER_COMPLETED" },
      }));
      for (const bot of [xena, yuri, zora]) f.play(bot.id, "happy", { FAKE_CLAUDE_ROOM_PLAN: planFile });
      await f.send(pair, "@Xena @Yuri INITIAL_HANDOFF_QUESTION please review independently");
      await expect.poll(() => existsSync(ready), POLL).toBe(true);
      await expect.poll(() => f.replied(pair.threadId, yuri.id, "YURI_INDEPENDENT_DONE"), POLL).toBe(true);
      const xenaLane = (await f.room(pair.id)).tasks!.find((task) => task.parallelReply?.botId === xena.id)!.threadId;
      expect((await f.task(pair.id, pair.threadId))?.working).toBe(true);
      expect((await f.task(pair.id, pair.threadId))?.activeResponders).toContainEqual(expect.objectContaining({ botId: xena.id, threadId: xenaLane }));
      expect(await f.replied(pair.threadId, xena.id, "XENA_FINAL_AFTER_HELPER")).toBe(false);
      f.evidence(`delegated-${action}-waiting`, { room: await f.room(pair.id), messages: await f.messages(pair.threadId) });
      if (action === "stop") await f.stop(pair);
      f.release(gate);
      if (action === "complete") await expect.poll(() => f.replied(pair.threadId, xena.id, "XENA_FINAL_AFTER_HELPER"), POLL).toBe(true);
      await f.idle(pair);
      if (action === "stop") {
        await expect.poll(async () => (await f.fleet()).bots.filter((bot) => [xena.id, yuri.id, zora.id].includes(bot.id)).every((bot) => !bot.busy), POLL).toBe(true);
        expect(await f.replied(pair.threadId, xena.id, "XENA_FINAL_AFTER_HELPER")).toBe(false);
      } else {
        const final = (await f.messages(pair.threadId)).filter((message) => message.from?.botId === xena.id && message.kind === "text").map((message) => message.text).join("\n");
        expect(final.match(/XENA_FINAL_AFTER_HELPER/g)).toHaveLength(1);
        const count = (await f.room(pair.id)).tasks!.length;
        const yuriPid = f.dump(yuri.id).pid;
        await f.send({ id: pair.id, threadId: xenaLane }, "LANE_FOLLOWUP_ONLY expand your answer");
        await expect.poll(() => f.replied(xenaLane, xena.id, "XENA_FOLLOWUP_ONLY"), POLL).toBe(true);
        await f.idle({ id: pair.id, threadId: xenaLane });
        expect((await f.room(pair.id)).tasks).toHaveLength(count);
        expect(f.dump(yuri.id).pid).toBe(yuriPid);
        expect(f.prompt(xena.id)).toContain("INITIAL_HANDOFF_QUESTION");
      }
      f.evidence(`delegated-${action}-finished`, { room: await f.room(pair.id), messages: await f.messages(pair.threadId), lane: await f.messages(xenaLane) });
    } finally {
      await f.close();
    }
  }, 120_000);

  it("finishes each mirrored response after its own approval or denial", async () => {
    const f = await launch();
    try {
      const xena = await f.newBot("Xena");
      const yuri = await f.newBot("Yuri");
      const pair = await f.newRoom("Independent approval results", [xena, yuri], true);
      const planFile = join(f.info.dataDir, "parallel-decisions.json");
      writeFileSync(planFile, JSON.stringify({
        [xena.id]: { approve: { tool_name: "Bash", input: { command: "echo xena" } }, reply: "XENA_APPROVED_RESPONSE", replyIfDenied: "XENA_DENIED_RESPONSE" },
        [yuri.id]: { approve: { tool_name: "Bash", input: { command: "echo yuri" } }, reply: "YURI_APPROVED_RESPONSE", replyIfDenied: "YURI_DENIED_RESPONSE" },
      }));
      for (const bot of [xena, yuri]) {
        await f.api("PATCH", `/api/bots/${bot.id}`, { approvalMode: "ask" });
        f.play(bot.id, "happy", { FAKE_CLAUDE_ROOM_PLAN: planFile });
      }
      await f.send(pair, "Each member must wait for their own action decision");
      await expect.poll(async () => (await f.task(pair.id, pair.threadId))?.activeResponders?.filter((member) => member.state === "waiting-on-you").length, POLL).toBe(2);
      for (const [index, bot] of [xena, yuri].entries()) {
        const laneId = f.providerThread(bot.id)!;
        const card = (await f.messages(laneId)).find((message) => message.kind === "options" && message.card?.requestId)!.card!;
        await f.api("POST", `/api/threads/${laneId}/respond`, { requestId: card.requestId, behavior: index === 0 ? "allow" : "deny" });
        if (index === 0) {
          await expect.poll(() => f.replied(pair.threadId, xena.id, "XENA_APPROVED_RESPONSE"), POLL).toBe(true);
          expect((await f.task(pair.id, pair.threadId))?.working).toBe(true);
          expect(await f.replied(pair.threadId, yuri.id, "YURI_DENIED_RESPONSE")).toBe(false);
        }
      }
      await expect.poll(() => f.replied(pair.threadId, yuri.id, "YURI_DENIED_RESPONSE"), POLL).toBe(true);
      await f.idle(pair);
      f.evidence("approval-decisions-completed", { room: await f.room(pair.id), messages: await f.messages(pair.threadId) });
    } finally {
      await f.close();
    }
  }, 120_000);
});
