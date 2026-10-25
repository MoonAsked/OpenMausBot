import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { closeBrowserSession, resolveAgentBrowserBinary } from "../../server/browser-engine.ts";
import { launchVerificationServer, runControlOmb } from "../control-omb.ts";
import { agentBrowser, ensureUiBrowser, sessionEnv, UI_TOOLS_DIR } from "./control-omb-ui.ts";
import { fixtureApi, mountPreview } from "./preview-fixture.ts";

const enabled = process.env.OMB_UI_E2E === "1" || Boolean(resolveAgentBrowserBinary({ dataDir: UI_TOOLS_DIR, env: process.env }));

(enabled ? it : it.skip)("saves parallel reply mode in the real renderer, shows both members, and returns from reply details", async () => {
  const { binary, chrome } = await ensureUiBrowser();
  const fixture = await launchVerificationServer(process.env, undefined, undefined,
    { binaryPath: binary, executablePath: chrome ?? "" }, undefined, { scripted: true });
  const api = fixtureApi(fixture.info.url);
  const evidenceDir = resolve(process.env.OMB_PARALLEL_UI_EVIDENCE_DIR ?? ".omb-scratch/parallel-room-ui");
  mkdirSync(evidenceDir, { recursive: true });
  const handle = { home: fixture.info.dataDir, session: `parallel-ui-${new URL(fixture.info.url).port}`, chrome };
  const env = sessionEnv(handle);
  let preview: Awaited<ReturnType<typeof mountPreview>> | undefined;
  let opened = false;
  const browser = (...args: string[]) => agentBrowser(binary, env, args);
  const snapshot = async () => (await browser("snapshot")).snapshot as string;
  const ref = async (name: string, role: string) => {
    const refs = (await browser("snapshot")).refs as Record<string, { name: string; role: string }>;
    const matches = Object.entries(refs).filter(([, entry]) => entry.role === role && entry.name === name);
    expect(matches, `Expected one ${role} named ${name}: ${JSON.stringify(refs)}`).toHaveLength(1);
    return `@${matches[0]![0]}`;
  };
  const screenshot = (name: string) => browser("screenshot", join(evidenceDir, `${name}.png`));
  try {
    await api("PATCH", "/api/config", { language: "en" });
    const control = (...args: string[]) => runControlOmb([...args, "--url", fixture.info.url]) as Promise<any>;
    const ada = (await control("new-bot", "--name", "Ada")).bot;
    const ben = (await control("new-bot", "--name", "Ben")).bot;
    const group = (await api("POST", "/api/groups", {
      name: "Parallel studio", memberIds: [ada.id, ben.id],
      setup: { bulletin: "Review the plan independently.", defaultResponder: { kind: "everyone" } },
    })).group;
    const parentThreadId = group.threadId;
    const room = async () => (await api("GET", "/api/bots?messages=0")).groups.find((candidate: any) => candidate.id === group.id);
    const gate = join(fixture.info.dataDir, "parallel-ui.gate");
    writeFileSync(join(fixture.info.dataDir, "room-plan.json"), JSON.stringify({
      [ada.id]: { gateFile: gate, reply: "Ada independently reviewed the plan." },
      [ben.id]: { gateFile: gate, reply: "Ben independently reviewed the plan." },
    }));
    preview = await mountPreview(fixture, { entry: "/scripts/testing/threads-preview.tsx", route: "/__parallel-room.html", title: "Parallel room verification", logLevel: "warn" });
    await browser("open", preview.previewUrl);
    opened = true;
    await browser("set", "viewport", "1440", "1000");
    await expect.poll(snapshot, { timeout: 30_000 }).toContain("Parallel studio");
    if ((await snapshot()).includes('dialog "Meet Fixture Starter"')) {
      await browser("click", await ref("Not now", "button"));
    }
    const initial = await browser("snapshot");
    const roomRefs = Object.entries(initial.refs as Record<string, { name: string; role: string }>).filter(([, entry]) => entry.role === "button" && entry.name.includes("Parallel studio"));
    expect(roomRefs, JSON.stringify(initial)).toHaveLength(1);
    await browser("click", `@${roomRefs[0]![0]}`);
    await expect.poll(snapshot, { timeout: 15_000 }).toContain('combobox "Reply mode"');
    await browser("select", await ref("Reply mode", "combobox"), "parallel");
    await expect.poll(async () => (await room()).responseMode, { timeout: 15_000 }).toBe("parallel");
    const saved = JSON.parse(readFileSync(join(fixture.info.dataDir, "groups.json"), "utf8"));
    expect(saved.find((candidate: any) => candidate.id === group.id).responseMode).toBe("parallel");
    expect(await snapshot()).toContain("same starting context");
    await screenshot("parallel-mode-selected");

    const composerRefs = (await browser("snapshot")).refs as Record<string, { name: string; role: string }>;
    const composer = Object.entries(composerRefs).find(([, entry]) => entry.role === "textbox" && entry.name.startsWith("Message"));
    expect(composer).toBeDefined();
    await browser("type", `@${composer![0]}`, "Compare two independent approaches to this plan.");
    await browser("press", "Enter");
    await expect.poll(async () => ((await room()).tasks.find((task: any) => task.threadId === parentThreadId)?.activeResponders ?? []).filter((entry: any) => entry.state === "running").length, { timeout: 30_000 }).toBe(2);
    await expect.poll(snapshot, { timeout: 15_000 }).toContain("Ada · Replying · open details");
    expect(await snapshot()).toContain("Ben · Replying · open details");
    expect(JSON.stringify(await browser("eval", 'document.querySelector(\'textarea[aria-label="Message Parallel studio"]\').placeholder'))).toContain("queues your message");
    const running = await room();
    const runningSnapshot = await snapshot();
    await screenshot("parallel-members-running");
    await browser("click", await ref("Ada · Replying · open details", "button"));
    await expect.poll(snapshot, { timeout: 15_000 }).toContain("Back to the original group question");
    const detailSnapshot = await snapshot();
    await screenshot("parallel-member-details");
    await browser("click", await ref("Back to the original group question", "button"));
    await expect.poll(async () => (await room()).threadId, { timeout: 15_000 }).toBe(parentThreadId);
    await expect.poll(snapshot, { timeout: 15_000 }).toContain("Ben · Replying · open details");
    writeFileSync(gate, "finish");
    await expect.poll(snapshot, { timeout: 30_000 }).toContain("Ada independently reviewed the plan.");
    await expect.poll(snapshot, { timeout: 30_000 }).toContain("Ben independently reviewed the plan.");
    await expect.poll(async () => Boolean((await room()).tasks.find((task: any) => task.threadId === parentThreadId)?.working), { timeout: 15_000 }).toBe(false);
    await screenshot("parallel-results");
    await api("PATCH", "/api/config", { language: "zh" });
    await expect.poll(snapshot, { timeout: 15_000 }).toContain("并行回复");
    await browser("set", "viewport", "1000", "800");
    await screenshot("parallel-results-zh");
    writeFileSync(join(evidenceDir, "parallel-room-ui.json"), JSON.stringify({
      fixture: fixture.info, previewUrl: preview.previewUrl, running, runningSnapshot, detailSnapshot,
      final: await room(), finalSnapshot: await snapshot(), browserConsole: await browser("console"),
    }, null, 2));
    console.log("Parallel room UI evidence:", join(evidenceDir, "parallel-room-ui.json"));
  } catch (error) {
    if (opened) {
      await screenshot("parallel-ui-failure").catch(() => undefined);
      writeFileSync(join(evidenceDir, "parallel-ui-failure.json"), JSON.stringify({ error: String(error), snapshot: await snapshot().catch(String), browserConsole: await browser("console").catch(String) }, null, 2));
    }
    throw error;
  } finally {
    if (opened) await closeBrowserSession(binary, env);
    await preview?.close();
    await fixture.close();
  }
}, 180_000);
