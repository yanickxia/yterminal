import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface SshHostProfile {
  id: string;
  name: string;
  sshTarget: string;
}

export type HostStatus = "offline" | "connecting" | "online" | "error";

interface HostRuntimeStatus {
  status: HostStatus;
  message?: string;
  deviceId?: string;
  hostname?: string;
  os?: string;
  agentVersion?: string;
}

interface HostState {
  profiles: SshHostProfile[];
  runtime: Record<string, HostRuntimeStatus>;
  addHost: (name?: string, sshTarget?: string) => string;
  updateHost: (id: string, patch: Partial<Omit<SshHostProfile, "id">>) => void;
  removeHost: (id: string) => void;
  setRuntime: (id: string, runtime: HostRuntimeStatus) => void;
}

function newHostId(): string {
  try {
    return `ssh-${crypto.randomUUID()}`;
  } catch {
    return `ssh-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

export const useHostStore = create<HostState>()(
  persist(
    (set) => ({
      profiles: [],
      runtime: {},
      addHost: (name = "Remote", sshTarget = "") => {
        const id = newHostId();
        set((state) => ({
          profiles: [...state.profiles, { id, name, sshTarget }],
        }));
        return id;
      },
      updateHost: (id, patch) =>
        set((state) => ({
          profiles: state.profiles.map((profile) =>
            profile.id === id ? { ...profile, ...patch } : profile
          ),
        })),
      removeHost: (id) =>
        set((state) => {
          const runtime = { ...state.runtime };
          delete runtime[id];
          return {
            profiles: state.profiles.filter((profile) => profile.id !== id),
            runtime,
          };
        }),
      setRuntime: (id, runtime) =>
        set((state) => ({
          runtime: { ...state.runtime, [id]: runtime },
        })),
    }),
    {
      name: "yterminal.ssh-hosts",
      version: 1,
      partialize: (state) => ({ profiles: state.profiles }),
    }
  )
);
