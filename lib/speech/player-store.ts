"use client";

import { create } from "zustand";
import type { SpeechTarget } from "@/lib/schemas/speech";
import type { VoiceProvider } from "@/lib/speech/voices";

/**
 * Step 9.4: the read-aloud player (one at a time across the app).
 *
 * Natural voices: segment 1 plays as soon as its audio is ready while the
 * next one is fetched; speed is the audio's playback rate (no new synthesis).
 * Browser voices: the browser speaks each segment (no server call, no
 * credits). When natural audio can't be had (plan, daily limit, provider
 * down) the player carries on with the browser voice from that segment.
 * Stop aborts any synthesis still running.
 */
export type PlayerStatus = "idle" | "loading" | "playing" | "paused";
export type FallbackReason = "unavailable" | "daily_limit" | "plan";

interface Segment {
  index: number;
  text: string;
}

interface PlayerState {
  targetKey: string | null;
  status: PlayerStatus;
  provider: VoiceProvider;
  index: number;
  total: number;
  speed: number;
  truncated: boolean;
  /** Set when the player switched to the browser voice; the UI says why once. */
  fallback: FallbackReason | null;
  error: string | null;
  start: (target: SpeechTarget) => Promise<void>;
  pause: () => void;
  resume: () => void;
  stop: () => void;
  skip: (delta: number) => void;
  setSpeed: (speed: number) => void;
}

export function speechTargetKey(t: SpeechTarget): string {
  if (t.type === "RESPONSE_VERSION") return `v:${t.id}:${t.source ?? "ORIGINAL"}:${t.editRevision ?? ""}`;
  if (t.type === "DOCUMENT_REVISION") return `d:${t.id}:${t.revision ?? ""}`;
  return `m:${t.id}`;
}

// Playback internals (not React state).
let audio: HTMLAudioElement | null = null;
let segments: Segment[] = [];
let target: SpeechTarget | null = null;
let voiceId: string | null = null;
let session = 0;
const controllers = new Set<AbortController>();
const prefetched = new Map<number, Promise<string>>();

class SpeechHttpError extends Error {
  constructor(
    public status: number,
    public code: string
  ) {
    super(code);
  }
}

async function postJson<T>(url: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new SpeechHttpError(res.status, json?.error?.code ?? `http_${res.status}`);
  return json?.data as T;
}

function fetchSegment(index: number): Promise<string> {
  const existing = prefetched.get(index);
  if (existing) return existing;
  const controller = new AbortController();
  controllers.add(controller);
  const p = postJson<{ url: string }>(
    "/api/v1/speech/segment",
    { target, index, voiceId: voiceId ?? undefined },
    controller.signal
  )
    .then((d) => d.url)
    .finally(() => controllers.delete(controller));
  prefetched.set(index, p);
  // A failed prefetch is retried when that segment's turn comes.
  p.catch(() => prefetched.delete(index));
  return p;
}

function browserVoice(name: string | null): SpeechSynthesisVoice | undefined {
  if (!name || typeof window === "undefined" || !("speechSynthesis" in window)) return undefined;
  return window.speechSynthesis.getVoices().find((v) => v.name === name);
}

function cleanupPlayback() {
  session++;
  for (const c of controllers) c.abort();
  controllers.clear();
  prefetched.clear();
  if (audio) {
    audio.onended = null;
    audio.onerror = null;
    audio.pause();
    audio.removeAttribute("src");
    audio = null;
  }
  if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
}

export const useReadAloud = create<PlayerState>((set, get) => {
  const finish = () => {
    cleanupPlayback();
    set({ status: "idle", targetKey: null, index: 0, total: 0 });
  };

  const playBrowser = (index: number, mySession: number) => {
    const seg = segments[index];
    if (!seg) return finish();
    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      set({ error: "unsupported" });
      return finish();
    }
    const u = new SpeechSynthesisUtterance(seg.text);
    u.rate = get().speed;
    u.lang = document.documentElement.lang || "en";
    const v = browserVoice(get().provider === "browser" ? voiceId : null);
    if (v) u.voice = v;
    u.onend = () => {
      if (mySession !== session) return;
      playFrom(index + 1);
    };
    u.onerror = () => {
      if (mySession !== session) return;
      playFrom(index + 1);
    };
    set({ index, status: "playing" });
    window.speechSynthesis.speak(u);
  };

  const switchToBrowser = (index: number, reason: FallbackReason, mySession: number) => {
    if (mySession !== session) return;
    set({ provider: "browser", fallback: reason });
    voiceId = null;
    playBrowser(index, mySession);
  };

  const playFrom = async (index: number) => {
    const mySession = session;
    if (index >= segments.length) return finish();
    if (get().provider === "browser") return playBrowser(index, mySession);
    set({ index, status: "loading" });
    try {
      const url = await fetchSegment(index);
      if (mySession !== session) return;
      if (index + 1 < segments.length) void fetchSegment(index + 1).catch(() => undefined);
      audio ??= new Audio();
      audio.src = url;
      audio.playbackRate = get().speed;
      audio.onended = () => {
        if (mySession === session) void playFrom(index + 1);
      };
      audio.onerror = () => {
        if (mySession === session) switchToBrowser(index, "unavailable", mySession);
      };
      await audio.play();
      if (mySession === session) set({ status: "playing" });
    } catch (err) {
      if (mySession !== session) return;
      const code = err instanceof SpeechHttpError ? err.code : "speech_unavailable";
      if (err instanceof DOMException && err.name === "NotAllowedError") {
        set({ status: "paused" });
        return;
      }
      switchToBrowser(
        index,
        code === "daily_read_aloud_limit" ? "daily_limit" : code === "plan_upgrade_required" ? "plan" : "unavailable",
        mySession
      );
    }
  };

  return {
    targetKey: null,
    status: "idle",
    provider: "browser",
    index: 0,
    total: 0,
    speed: 1,
    truncated: false,
    fallback: null,
    error: null,

    start: async (t) => {
      cleanupPlayback();
      const mySession = session;
      target = t;
      set({ targetKey: speechTargetKey(t), status: "loading", index: 0, total: 0, fallback: null, error: null });
      try {
        const prep = await postJson<{
          provider: VoiceProvider;
          voiceId: string | null;
          speed: number;
          truncated: boolean;
          segments: Segment[];
        }>("/api/v1/speech", { target: t });
        if (mySession !== session) return;
        segments = prep.segments;
        voiceId = prep.voiceId;
        set({ provider: prep.provider, speed: prep.speed, total: prep.segments.length, truncated: prep.truncated });
        if (prep.segments.length === 0) return finish();
        await playFrom(0);
      } catch (err) {
        if (mySession !== session) return;
        set({ error: err instanceof SpeechHttpError ? err.code : "speech_unavailable" });
        finish();
      }
    },

    pause: () => {
      if (get().status !== "playing" && get().status !== "loading") return;
      if (audio && !audio.paused) audio.pause();
      if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.pause();
      set({ status: "paused" });
    },

    resume: () => {
      if (get().status !== "paused") return;
      if (get().provider === "browser") {
        if (window.speechSynthesis.paused) window.speechSynthesis.resume();
        else playFrom(get().index);
        set({ status: "playing" });
        return;
      }
      if (audio?.src) {
        void audio.play().then(() => set({ status: "playing" }));
      } else void playFrom(get().index);
    },

    stop: () => finish(),

    skip: (delta) => {
      const next = Math.min(Math.max(get().index + delta, 0), Math.max(segments.length - 1, 0));
      const provider = get().provider;
      // Restart cleanly at the new segment (keeps prefetches of the natural voice).
      session++;
      if (audio) {
        audio.onended = null;
        audio.pause();
      }
      if (provider === "browser" && typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
      void playFrom(next);
    },

    setSpeed: (speed) => {
      set({ speed });
      if (audio) audio.playbackRate = speed;
      // The browser voice takes a new rate on the next utterance: restart this segment.
      if (get().provider === "browser" && get().status === "playing") get().skip(0);
    },
  };
});

/** For tests: drop any playback. */
export function resetReadAloudForTesting() {
  cleanupPlayback();
  segments = [];
  target = null;
  voiceId = null;
  useReadAloud.setState({ targetKey: null, status: "idle", index: 0, total: 0, fallback: null, error: null });
}
