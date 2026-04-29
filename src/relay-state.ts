export type RelayUser = {
  id: string;
  githubId: number;
  githubLogin: string;
  slug: string;
  createdAt: number;
  updatedAt: number;
};

export type RelayBrowserSession = {
  token: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
};

export type RelayDispatcherSession = {
  id: string;
  userId: string;
  deviceId: string;
  connectedAt: number;
  lastSeenAt: number;
};

export type RelayDevice = {
  id: string;
  userId: string;
  token: string;
  createdAt: number;
  lastLoginAt: number;
};

export type RelayStateSnapshot = {
  version: 1;
  nextUserOrdinal: number;
  nextDeviceOrdinal: number;
  users: RelayUser[];
  browserSessions: RelayBrowserSession[];
  devices: RelayDevice[];
};

export type GitHubIdentity = {
  id: number;
  login: string;
};

export type ConnectDispatcherInput = {
  sessionId: string;
  userId: string;
  deviceId: string;
  now: number;
  killExisting: boolean;
};

export type ConnectDispatcherResult =
  | {
      ok: true;
      session: RelayDispatcherSession;
      killedSessionId: string | null;
    }
  | {
      ok: false;
      error: {
        code: "dispatcher.already_active";
        activeSession: RelayDispatcherSession;
      };
    };

export type RelayTokenGenerator = () => string;

const browserSessionTtlMs = 1000 * 60 * 60 * 24 * 30;

export class RelayState {
  private readonly usersById = new Map<string, RelayUser>();
  private readonly userIdsByGithubId = new Map<number, string>();
  private readonly userIdsBySlug = new Map<string, string>();
  private readonly browserSessionsByToken = new Map<string, RelayBrowserSession>();
  private readonly devicesByToken = new Map<string, RelayDevice>();
  private readonly dispatcherSessionsByUserId = new Map<string, RelayDispatcherSession>();
  private nextUserOrdinal = 1;
  private nextDeviceOrdinal = 1;

  static fromSnapshot(snapshot: RelayStateSnapshot): RelayState {
    const state = new RelayState();
    state.nextUserOrdinal = snapshot.nextUserOrdinal;
    state.nextDeviceOrdinal = snapshot.nextDeviceOrdinal;
    for (const user of snapshot.users) {
      state.usersById.set(user.id, user);
      state.userIdsByGithubId.set(user.githubId, user.id);
      state.userIdsBySlug.set(user.slug, user.id);
    }
    for (const session of snapshot.browserSessions) {
      state.browserSessionsByToken.set(session.token, session);
    }
    for (const device of snapshot.devices) {
      state.devicesByToken.set(device.token, device);
    }
    return state;
  }

  upsertGitHubUser(identity: GitHubIdentity, now: number): RelayUser {
    const existingUserId = this.userIdsByGithubId.get(identity.id);
    if (existingUserId) {
      const existing = this.requiredUser(existingUserId);
      const updated = {
        ...existing,
        githubLogin: identity.login,
        updatedAt: now,
      };
      this.usersById.set(updated.id, updated);
      return updated;
    }

    const id = `usr_${this.nextUserOrdinal.toString(36)}`;
    this.nextUserOrdinal += 1;
    const slug = this.allocateSlug(identity.login, id);
    const user: RelayUser = {
      id,
      githubId: identity.id,
      githubLogin: identity.login,
      slug,
      createdAt: now,
      updatedAt: now,
    };
    this.usersById.set(id, user);
    this.userIdsByGithubId.set(identity.id, id);
    this.userIdsBySlug.set(slug, id);
    return user;
  }

  createBrowserSession(userId: string, now: number, generateToken: RelayTokenGenerator): RelayBrowserSession {
    this.requiredUser(userId);
    const session: RelayBrowserSession = {
      token: generateToken(),
      userId,
      createdAt: now,
      expiresAt: now + browserSessionTtlMs,
    };
    this.browserSessionsByToken.set(session.token, session);
    return session;
  }

  createDevice(userId: string, now: number, generateToken: RelayTokenGenerator): RelayDevice {
    this.requiredUser(userId);
    const device: RelayDevice = {
      id: `dev_${this.nextDeviceOrdinal.toString(36)}`,
      userId,
      token: generateToken(),
      createdAt: now,
      lastLoginAt: now,
    };
    this.nextDeviceOrdinal += 1;
    this.devicesByToken.set(device.token, device);
    return device;
  }

  authenticateDevice(token: string, now: number): RelayDevice | null {
    const device = this.devicesByToken.get(token);
    if (!device) {
      return null;
    }
    const updated = { ...device, lastLoginAt: now };
    this.devicesByToken.set(token, updated);
    return updated;
  }

  authenticateBrowserSession(token: string, now: number): RelayUser | null {
    const session = this.browserSessionsByToken.get(token);
    if (!session) {
      return null;
    }
    if (session.expiresAt <= now) {
      this.browserSessionsByToken.delete(token);
      return null;
    }
    return this.requiredUser(session.userId);
  }

  connectDispatcher(input: ConnectDispatcherInput): ConnectDispatcherResult {
    this.requiredUser(input.userId);
    const active = this.dispatcherSessionsByUserId.get(input.userId);
    if (active && !input.killExisting) {
      return {
        ok: false,
        error: {
          code: "dispatcher.already_active",
          activeSession: active,
        },
      };
    }

    const session: RelayDispatcherSession = {
      id: input.sessionId,
      userId: input.userId,
      deviceId: input.deviceId,
      connectedAt: input.now,
      lastSeenAt: input.now,
    };
    this.dispatcherSessionsByUserId.set(input.userId, session);
    return {
      ok: true,
      session,
      killedSessionId: active?.id ?? null,
    };
  }

  disconnectDispatcher(userId: string, sessionId: string): void {
    const active = this.dispatcherSessionsByUserId.get(userId);
    if (active?.id === sessionId) {
      this.dispatcherSessionsByUserId.delete(userId);
    }
  }

  activeDispatcherForSlug(slug: string): RelayDispatcherSession | null {
    const userId = this.userIdsBySlug.get(slug);
    if (!userId) {
      return null;
    }
    return this.dispatcherSessionsByUserId.get(userId) ?? null;
  }

  userForSlug(slug: string): RelayUser | null {
    const userId = this.userIdsBySlug.get(slug);
    return userId ? this.requiredUser(userId) : null;
  }

  userForId(userId: string): RelayUser | null {
    return this.usersById.get(userId) ?? null;
  }

  snapshot(): RelayStateSnapshot {
    return {
      version: 1,
      nextUserOrdinal: this.nextUserOrdinal,
      nextDeviceOrdinal: this.nextDeviceOrdinal,
      users: Array.from(this.usersById.values()),
      browserSessions: Array.from(this.browserSessionsByToken.values()),
      devices: Array.from(this.devicesByToken.values()),
    };
  }

  private requiredUser(userId: string): RelayUser {
    const user = this.usersById.get(userId);
    if (!user) {
      throw new Error(`Unknown relay user: ${userId}`);
    }
    return user;
  }

  private allocateSlug(login: string, userId: string): string {
    const base = slugifyGitHubLogin(login);
    let slug = base;
    let suffix = 2;
    while (true) {
      const existingUserId = this.userIdsBySlug.get(slug);
      if (!existingUserId || existingUserId === userId) {
        return slug;
      }
      slug = `${base}-${suffix}`;
      suffix += 1;
    }
  }
}

export function slugifyGitHubLogin(login: string): string {
  const slug = login
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  if (!slug) {
    throw new Error("GitHub login cannot be converted to a relay slug.");
  }
  return slug;
}
