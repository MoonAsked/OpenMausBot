import { t } from "@/lib/i18n";
import { openThread, useStore, type Group } from "@/state/store";
import { useShowThreads } from "@/lib/thread-preferences";
import { Select } from "./Select";

export function ParallelReplyParentLink({ group }: { group: Group }) {
  const { state, dispatch } = useStore();
  const showThreads = useShowThreads();
  const reply = group.tasks?.find((task) => task.threadId === group.threadId)?.parallelReply;
  if (!reply) return null;
  return (
    <div className="mb-1 px-7">
      <button
        type="button"
        data-testid="parallel-reply-parent"
        className="cursor-pointer text-[12px] text-accent hover:underline"
        onClick={() => openThread(dispatch, { botId: group.id, threadId: reply.parentThreadId }, state, showThreads)}
      >
        {t("room.responseMode.backToQuestion")}
      </button>
    </div>
  );
}

export function RoomResponseModeSelect({ group }: { group: Group }) {
  const { dispatch } = useStore();
  return (
    <Select
      variant="pill"
      size="sm"
      className="shrink-0 max-w-[170px]"
      aria-label={t("room.responseMode.label")}
      title={t(`room.responseMode.${group.responseMode ?? "sequential"}Detail`)}
      value={group.responseMode ?? "sequential"}
      disabled={Boolean(group.working)}
      onChange={(event) => dispatch({
        type: "patchGroup",
        groupId: group.id,
        patch: {
          responseMode: event.target.value === "parallel" || event.target.value === "broadcast"
            ? event.target.value
            : "sequential",
        },
      })}
    >
      <option value="sequential">{t("room.responseMode.sequential")}</option>
      <option value="parallel">{t("room.responseMode.parallel")}</option>
      <option value="broadcast">{t("room.responseMode.broadcast")}</option>
    </Select>
  );
}
