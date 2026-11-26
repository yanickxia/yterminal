import { create } from "zustand";
import type { PtyAgentObservation } from "../lib/agent-pty";

interface AgentPtyStore {
  observations: Map<string, PtyAgentObservation>;
  set: (paneId: string, observation: PtyAgentObservation | undefined) => void;
}

export const useAgentPtyStore = create<AgentPtyStore>((set) => ({
  observations: new Map(),
  set: (paneId, observation) => set((previous) => {
    const existing = previous.observations.get(paneId);
    if (existing?.instanceId === observation?.instanceId && existing?.state === observation?.state && existing?.source === observation?.source && existing?.reason === observation?.reason) return previous;
    const observations = new Map(previous.observations);
    if (observation) observations.set(paneId, observation);
    else observations.delete(paneId);
    return { observations };
  }),
}));

export const setPtyObservation = (paneId: string, observation?: PtyAgentObservation) =>
  useAgentPtyStore.getState().set(paneId, observation);
