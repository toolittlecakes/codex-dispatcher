import type { JsonObject } from "./codex-app-server";
import { applyJsonPatches, cloneJson } from "./json-patch";
import { asJsonObject, isJsonObject } from "./shared";

export type StreamStateOutcome = "adopted" | "patched" | "ignored" | "patch-failed";

type MirroredThread = { conversation: JsonObject; revision: number | null; ownerClientId: string };

// The follower half of the stream protocol whose owner half is in
// `dispatcher-owner.ts`. Every client on the bus broadcasts patches for the
// threads it owns, so a follower constantly sees changes built on state it does
// not have; the extension answers those by checking the sender against the
// owner its last snapshot named and the patch's `baseRevision` against the
// revision it holds, and ignoring whatever fails either test. Only a snapshot
// names an owner, and nothing here ever unnames one — that is why the three
// maps live behind this class rather than in the dispatcher: a mirror that
// cannot follow along has to go stale and wait for the next snapshot, and
// forgetting the owner instead is what left every follower request — stop above
// all — answered with «No IPC owner».
export class ThreadMirrors {
  private readonly conversations = new Map<string, JsonObject>();
  private readonly revisions = new Map<string, number>();
  private readonly owners = new Map<string, string>();

  apply(threadId: string, params: JsonObject, sourceClientId: string): StreamStateOutcome {
    const change = asJsonObject(params.change);
    if (!change) {
      return "ignored";
    }

    if (change.type === "snapshot") {
      return this.adopt(threadId, change, sourceClientId);
    }

    const current = this.mirrored(threadId);
    if (
      change.type !== "patches" ||
      !Array.isArray(change.patches) ||
      !current ||
      current.ownerClientId !== sourceClientId ||
      current.revision !== revisionOf(change.baseRevision)
    ) {
      return "ignored";
    }

    try {
      const next = applyJsonPatches(current.conversation, change.patches);
      if (!isJsonObject(next)) {
        return "patch-failed";
      }

      this.conversations.set(threadId, next);
      this.setRevision(threadId, revisionOf(change.revision));
      return "patched";
    } catch {
      return "patch-failed";
    }
  }

  ownerOf(threadId: string): string | null {
    return this.owners.get(threadId) ?? null;
  }

  has(threadId: string): boolean {
    return this.conversations.has(threadId);
  }

  threadIds(): string[] {
    return [...this.conversations.keys()];
  }

  ownersByThread(): Record<string, string> {
    return Object.fromEntries(this.owners);
  }

  forgetClient(clientId: string): void {
    for (const [threadId, ownerClientId] of this.owners.entries()) {
      if (ownerClientId === clientId) {
        this.forget(threadId);
      }
    }
  }

  forget(threadId: string): void {
    this.conversations.delete(threadId);
    this.revisions.delete(threadId);
    this.owners.delete(threadId);
  }

  clear(): void {
    this.conversations.clear();
    this.revisions.clear();
    this.owners.clear();
  }

  private adopt(threadId: string, change: JsonObject, sourceClientId: string): StreamStateOutcome {
    const conversationState = asJsonObject(change.conversationState);
    if (!conversationState) {
      return "ignored";
    }

    this.conversations.set(threadId, {
      ...cloneJson(conversationState),
      id: typeof conversationState.id === "string" ? conversationState.id : threadId,
    });
    this.setRevision(threadId, revisionOf(change.revision));
    this.owners.set(threadId, sourceClientId);
    return "adopted";
  }

  private mirrored(threadId: string): MirroredThread | null {
    const conversation = this.conversations.get(threadId);
    const ownerClientId = this.owners.get(threadId);
    if (!conversation || !ownerClientId) {
      return null;
    }

    return { conversation, revision: this.revisions.get(threadId) ?? null, ownerClientId };
  }

  private setRevision(threadId: string, revision: number | null): void {
    if (revision === null) {
      this.revisions.delete(threadId);
      return;
    }

    this.revisions.set(threadId, revision);
  }
}

function revisionOf(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}
