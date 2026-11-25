import { test, expect, type Page } from "@playwright/test";
import { composer, newUser } from "./helpers";

/**
 * Journey 11 (after the interlude): voice input with a mocked microphone
 * (a generated tone; the browser's real MediaRecorder records it) and the
 * fake transcription → Stop inserts the text; Send while recording sends.
 */
const FAKE_TRANSCRIPT = "This is a fake transcript from the test voice provider.";

async function mockMicrophone(page: Page) {
  await page.addInitScript(() => {
    const fake = async () => {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new Ctx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.value = 0.05;
      const dest = ctx.createMediaStreamDestination();
      osc.connect(gain).connect(dest);
      osc.start();
      return dest.stream;
    };
    if (!navigator.mediaDevices) {
      Object.defineProperty(navigator, "mediaDevices", { value: {}, configurable: true });
    }
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", { value: fake, configurable: true });
  });
}

test("record a voice prompt: Stop inserts the transcript, Send while recording sends it", async ({ browser }) => {
  const { page } = await newUser(browser, "voice");
  await mockMicrophone(page);
  await page.reload();

  // Stop: the transcript lands in the composer, ready to edit.
  await page.getByRole("button", { name: "Record voice prompt" }).click();
  await page.waitForTimeout(1500);
  await page.getByRole("button", { name: /^Stop/ }).click();
  await expect(composer(page)).toHaveValue(new RegExp(FAKE_TRANSCRIPT.replace(/\./g, "\\.")));

  // Send while recording: transcribed and sent in one go.
  await composer(page).fill("");
  await page.getByRole("button", { name: "Record voice prompt" }).click();
  await page.waitForTimeout(1500);
  await page.getByRole("button", { name: /^Send/ }).click();
  await expect(page.locator("main").getByText(FAKE_TRANSCRIPT).first()).toBeVisible();
  await expect(page.getByText("A closing sentence ends the answer.")).toBeVisible();
});
