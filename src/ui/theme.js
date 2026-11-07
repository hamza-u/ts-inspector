// One icon toggles light and dark. The first time, "auto" is resolved from
// the system setting, then the user's own choice is stored.

export const THEME_KEY = "ts-inspector-theme";

export function readTheme(doc) {
  const root = doc.documentElement;
  const attr = root ? root.getAttribute("data-theme") : null;
  return attr === "light" || attr === "dark" ? attr : "auto";
}

export function resolveTheme(doc, choice) {
  if (choice === "light" || choice === "dark") return choice;
  try {
    const view = doc.defaultView;
    if (view && view.matchMedia && view.matchMedia("(prefers-color-scheme: dark)").matches) return "dark";
  } catch (err) {
    // No matchMedia: treat auto as light.
  }
  return "light";
}

export function applyTheme(doc, choice) {
  const value = choice === "light" || choice === "dark" ? choice : "auto";
  doc.documentElement.setAttribute("data-theme", value);
  try {
    doc.defaultView.localStorage.setItem(THEME_KEY, value);
  } catch (err) {
    // Private mode or storage disabled: the choice lasts for this page only.
  }
  const button = doc.getElementById ? doc.getElementById("theme") : null;
  if (button) {
    const next = resolveTheme(doc, value) === "dark" ? "light" : "dark";
    button.setAttribute("title", "Switch to " + next + " theme");
    button.setAttribute("aria-label", "Switch to " + next + " theme");
  }
  return value;
}

export function nextTheme(doc) {
  return resolveTheme(doc, readTheme(doc)) === "dark" ? "light" : "dark";
}
