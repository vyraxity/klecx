/**
 * @jest-environment jsdom
 */
import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogContent, AlertDialogTitle, AlertDialogCancel } from "@/components/ui/alert-dialog";

jest.mock("next-intl", () => jest.requireActual("../test-utils/next-intl").nextIntlMock);

/**
 * Step 10.5: a dialog opened from state (no Radix Trigger) gives focus back
 * to the element that opened it — before, focus fell to <body>.
 */
function StateDialog() {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Share
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent aria-describedby={undefined}>
          <DialogTitle>Share</DialogTitle>
          <input aria-label="Email" />
        </DialogContent>
      </Dialog>
    </>
  );
}

function StateAlert() {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Delete
      </button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent aria-describedby={undefined}>
          <AlertDialogTitle>Delete?</AlertDialogTitle>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

describe("Step 10.5 — focus returns to what opened a dialog", () => {
  it("Dialog: Escape puts focus back on the opening button", async () => {
    render(<StateDialog />);
    const opener = screen.getByRole("button", { name: "Share" });
    opener.focus();
    fireEvent.click(opener);
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("AlertDialog: Cancel puts focus back on the opening button", async () => {
    render(<StateAlert />);
    const opener = screen.getByRole("button", { name: "Delete" });
    opener.focus();
    fireEvent.click(opener);
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });
});
