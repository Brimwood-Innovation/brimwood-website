/* Render tests: every branded email template renders with all variables
 * supplied — no "undefined"/placeholder leaks, text alternative present,
 * brand shell intact. Template compositions mirror the route call sites. */
import { describe, it, expect } from "vitest";
import { shell, fieldRow, button, esc } from "./email";
import { digestBody } from "../cron";

const SITE = "https://brimwoodinnovation.com";
const LOGO = "https://brimwoodinnovation.com/logo-email.png";

function checkRendered(subject: string, html: string, text: string) {
  expect(subject.length).toBeGreaterThan(0);
  expect(html.length).toBeGreaterThan(0);
  expect(text.length).toBeGreaterThan(0);
  expect(html).toContain(LOGO);
  expect(html).toContain('lang="en"');
  expect(html).not.toContain("undefined");
  expect(html).not.toContain("{{");
  expect(text).not.toContain("undefined");
  expect(text).not.toContain("{{");
}

const introNotify = (name: string, email: string, referral: string, message: string) => ({
  subject: "New introduction request — " + name,
  html: shell(
    "New introduction request",
    "Someone requested an introduction on brimwoodinnovation.com.",
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0">' +
      fieldRow("Name", name) +
      fieldRow("Email", email) +
      fieldRow("Referred by", referral) +
      fieldRow("What they are building", message) +
      "</table>" +
      '<p style="font-size:13px;color:#5B6862;margin:24px 0 0;">Reply directly to this email to reach ' + esc(name) + ".</p>"
  ),
  text:
    "New introduction request — brimwoodinnovation.com\n\nName: " + name +
    "\nEmail: " + email + "\nReferred by: " + (referral || "—") +
    "\n\nWhat they are building:\n" + (message || "—"),
});

const introConfirm = (name: string) => ({
  subject: "Thank you — Brimwood Innovation",
  html: shell(
    "Request received",
    "Thank you — your introduction request is on its way.",
    '<p style="margin:0 0 16px;">Hello ' + esc(name) + ",</p>" +
      "<p style=\"margin:0 0 16px;\">Thank you. Your introduction request is on its way &mdash; we read every one personally and will be in touch.</p>" +
      '<p style="margin:0;font-size:13px;color:#5B6862;">Membership is by invitation. Elite by effort, not by background.</p>'
  ),
  text:
    "Hello " + name + ",\n\nThank you. Your introduction request is on its way — we read every one personally and will be in touch.\n\nBuild a business. Build yourself.\n— Brimwood Innovation",
});

const newsletterConfirm = (name: string | null, token: string) => {
  const verifyUrl = SITE + "/api/newsletter/verify?token=" + encodeURIComponent(token);
  return {
    subject: "Confirm your subscription — Brimwood Innovation",
    html: shell(
      "Confirm your subscription",
      "One more step to join the Brimwood list.",
      "<p style=\"margin:0 0 16px;\">Hello" + (name ? " " + esc(name) : "") + ",</p>" +
        "<p style=\"margin:0 0 8px;\">You asked to join the Brimwood Innovation list. Please confirm your email address:</p>" +
        button(verifyUrl, "Confirm my email") +
        '<p style="font-size:13px;color:#5B6862;margin:16px 0 0;">If you did not request this, just ignore this email — nothing will happen.</p>'
    ),
    text:
      "Hello" + (name ? " " + name : "") + ",\n\nYou asked to join the Brimwood Innovation list. Confirm your email address:\n" +
      verifyUrl + "\n\nIf you did not request this, just ignore this email.",
  };
};

const newsletterWelcome = (name: string | null, email: string, unsubToken: string) => {
  const unsubUrl =
    SITE + "/api/newsletter/unsubscribe?email=" + encodeURIComponent(email) +
    "&token=" + encodeURIComponent(unsubToken);
  return {
    subject: "You're on the list — Brimwood Innovation",
    html: shell(
      "You're on the list",
      "Welcome to Brimwood Innovation.",
      '<p style="margin:0 0 16px;">Hello' + (name ? " " + esc(name) : "") + ",</p>" +
        "<p style=\"margin:0 0 16px;\">You are on the list. We will write when there is something worth your time — no noise.</p>" +
        '<p style="margin:0;font-size:13px;color:#5B6862;">Build a business. Build yourself.</p>' +
        '<p style="font-size:12px;color:#5B6862;margin:24px 0 0;"><a href="' + esc(unsubUrl) + '" style="color:#5B6862;">Unsubscribe</a></p>'
    ),
    text:
      "Hello" + (name ? " " + name : "") + ",\n\nYou are on the list. We will write when there is something worth your time — no noise.\n\nBuild a business. Build yourself.\n— Brimwood Innovation\n\nUnsubscribe: " + unsubUrl,
    unsubUrl,
  };
};

describe("email templates render with all variables supplied", () => {
  it("introduction notify — full data", () => {
    const { subject, html, text } = introNotify("Ada", "ada@example.com", "Marcus", "A tiny CRM.");
    checkRendered(subject, html, text);
    expect(html).toContain("Ada");
  });

  it("introduction notify — empty optional fields render as em dash, not undefined", () => {
    const { subject, html, text } = introNotify("Ada", "ada@example.com", "", "");
    checkRendered(subject, html, text);
    expect(html).toContain("—");
  });

  it("introduction confirm", () => {
    const { subject, html, text } = introConfirm("Ada");
    checkRendered(subject, html, text);
  });

  it("newsletter double opt-in confirm — with and without name", () => {
    for (const name of ["Ada", null]) {
      const { subject, html, text } = newsletterConfirm(name, "tok-123");
      checkRendered(subject, html, text);
      expect(html).toContain("tok-123");
    }
  });

  it("newsletter welcome — includes working unsubscribe link, with and without name", () => {
    for (const name of ["Ada", null]) {
      const { subject, html, text, unsubUrl } = newsletterWelcome(name, "ada@example.com", "unsub-1");
      checkRendered(subject, html, text);
      expect(html).toContain(esc(unsubUrl));
      expect(text).toContain(unsubUrl);
    }
  });

  it("newsletter owner notice — empty name renders as em dash", () => {
    const html = shell(
      "New newsletter subscriber",
      "Someone joined the Brimwood list.",
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0">' +
        fieldRow("Email", "ada@example.com") +
        fieldRow("Name", "") +
        "</table>"
    );
    checkRendered("New newsletter subscriber — Brimwood Innovation", html, "New newsletter subscriber");
  });

  it("sign-in code email", () => {
    const code = "123456";
    const html = shell(
      "Your sign-in code",
      "Use this code within 10 minutes.",
      "<p style=\"margin:0 0 16px;\">Hello,</p>" +
        "<p style=\"margin:0 0 8px;\">Your Brimwood sign-in code is:</p>" +
        '<p style="font-size:36px;font-weight:700;letter-spacing:0.3em;color:#0C9463;margin:16px 0;">' + code + "</p>" +
        '<p style="font-size:13px;color:#5B6862;margin:16px 0 0;">It expires in 10 minutes. If you did not request this, just ignore it.</p>'
    );
    checkRendered("Your Brimwood sign-in code", html, "Your Brimwood sign-in code is: " + code);
  });

  it("invite-redeem magic code email — guarded name in text version", () => {
    for (const name of ["Ada", ""]) {
      const greeting = "Welcome to Brimwood" + (name ? ", " + name : "") + ".";
      const html = shell(
        "Your Brimwood sign-in code",
        "Welcome to Brimwood.",
        "<p style=\"margin:0 0 8px;\">Welcome" + (name ? ", " + esc(name) : "") + ". Your invite code worked — here is your sign-in code:</p>"
      );
      checkRendered("Welcome to Brimwood — your sign-in code", html, greeting);
    }
  });

  it("digest body — per-subscriber unsubscribe URL, no placeholders", () => {
    const unsubUrl = SITE + "/api/newsletter/unsubscribe?email=ada%40example.com&token=abc";
    const { html, text } = digestBody(
      '<p style="margin:0 0 12px;"><a href="' + SITE + '/blog/hello" style="color:#0C9463;font-weight:600;">Hello</a></p>',
      "",
      unsubUrl,
      { posts: [{ title: "Hello", url: SITE + "/blog/hello" }], lessons: [] }
    );
    checkRendered("This week at Brimwood", html, text);
    expect(html).toContain(esc(unsubUrl));
    expect(text).toContain(unsubUrl);
    expect(text).toContain(SITE + "/blog/hello");
  });

  it("RSVP confirm and form-submission notify templates", () => {
    const rsvp = shell(
      "You are on the list",
      "RSVP confirmed: Demo night",
      "<p style=\"margin:0 0 16px;\">Hello " + esc("Ada") + ",</p>"
    );
    checkRendered("Confirmed: Demo night — Brimwood Innovation", rsvp, "Hello Ada,\n\nYou are confirmed for Demo night.");
    const notify = shell(
      "New form submission",
      'Someone submitted "Contact".',
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0">' + fieldRow("Message", "Hi") + "</table>"
    );
    checkRendered("New submission — Contact", notify, "New submission for \"Contact\"");
  });

  it("esc neutralises HTML in user input", () => {
    expect(esc('<script>alert(1)</script>')).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
    const html = shell("T", "P", fieldRow("Name", "<b>Ada</b>"));
    expect(html).not.toContain("<b>Ada</b>");
  });
});
