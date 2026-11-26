/**
 * @jest-environment node
 */
jest.mock("../server/auth/session", () => ({ getActor: jest.fn() }));
jest.mock("next-intl/server", () => ({
  getTranslations: jest.fn(async (namespace: string) => {
    // The French catalogue, as the viewer's language.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fr = require("../messages/fr.json");
    return (key: string) => fr[namespace][key];
  }),
}));

import { NextRequest } from "next/server";
import { route } from "@/server/http/route";
import { getActor } from "../server/auth/session";
import {
  DELETED_USER_NAME,
  isDeletedUserEmail,
  localizeDeletedUserNames,
} from "@/lib/users/deleted-user";
import { deletedUserEmail } from "@/server/services/account-deletion";
import en from "@/messages/en.json";
import es from "@/messages/es.json";
import fr from "@/messages/fr.json";

/**
 * Step 10.5 (carried from Step 9.5): an erased account's stored name is the
 * English "Deleted user"; people see it in their own language.
 */
describe("Step 10.5 — \"Deleted user\" in the viewer's language", () => {
  it("has a translation in every language", () => {
    expect(en.User.deletedUser).toBe(DELETED_USER_NAME);
    expect(es.User.deletedUser).toBe("Usuario eliminado");
    expect(fr.User.deletedUser).toBe("Utilisateur supprimé");
  });

  it("recognises the anonymized address", () => {
    expect(isDeletedUserEmail(deletedUserEmail("abc"))).toBe(true);
    expect(isDeletedUserEmail("someone@example.com")).toBe(false);
    expect(isDeletedUserEmail(null)).toBe(false);
  });

  it("replaces only people's names equal to the stored text, at any depth", () => {
    const input = {
      title: DELETED_USER_NAME, // a title is not a person's name
      author: { id: "u1", name: DELETED_USER_NAME },
      messages: [
        { author: { name: "Ada" } },
        { author: { name: DELETED_USER_NAME, username: null } },
      ],
      actorName: DELETED_USER_NAME,
      untouched: { name: "Grace" },
    };
    const out = localizeDeletedUserNames(input, "Usuario eliminado");
    expect(out.title).toBe(DELETED_USER_NAME);
    expect(out.author.name).toBe("Usuario eliminado");
    expect(out.messages[0]!.author.name).toBe("Ada");
    expect(out.messages[1]!.author.name).toBe("Usuario eliminado");
    expect(out.actorName).toBe("Usuario eliminado");
    // Unchanged branches keep their identity; the input isn't mutated.
    expect(out.untouched).toBe(input.untouched);
    expect(out.messages[0]).toBe(input.messages[0]);
    expect(input.author.name).toBe(DELETED_USER_NAME);
  });

  it("route() answers with the viewer's translation", async () => {
    (getActor as jest.Mock).mockResolvedValue({ userId: "u", role: "USER", sessionId: "s", email: "u@example.com" });
    const handler = route({
      handler: async () => ({ comments: [{ body: "Hi", author: { name: DELETED_USER_NAME } }, { body: "Yo", author: { name: "Ada" } }] }),
    });
    const res = await handler(new NextRequest("http://localhost:3000/api/v1/test"));
    const json = await res.json();
    expect(json.data.comments[0].author.name).toBe("Utilisateur supprimé");
    expect(json.data.comments[1].author.name).toBe("Ada");
  });
});
