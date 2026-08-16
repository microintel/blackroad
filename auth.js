/* ============================================================
   BlackRoad Auth — shared client-side auth module
   ------------------------------------------------------------
   Used by login.html, register.html, account.html, logout.html
   and blackroad-dashboard.html so every page shares one source
   of truth for accounts + sessions.

   Storage:
   - Uses window.storage (Claude artifact sandbox) when present.
   - Falls back to localStorage automatically, so this also works
     as a real deployed site (e.g. GitHub Pages).
   - Accounts are saved as SHARED records keyed by email so any
     page/device using the same storage backend can look a user
     up by email to sign them in.
   - The active session is PERSONAL (per browser/user) so signing
     in on one device doesn't sign you in everywhere.

   Passwords are never stored in plain text — they're salted and
   run through SHA-256 (via SubtleCrypto) a few thousand times
   before being saved.
   ============================================================ */
(function (global) {
  "use strict";

  const hasWidgetStorage =
    typeof window !== "undefined" &&
    window.storage &&
    typeof window.storage.get === "function";

  /* ---------------- storage shim ---------------- */
  async function stGet(key, shared) {
    if (hasWidgetStorage) {
      try {
        const r = await window.storage.get(key, !!shared);
        return r ? r.value : null;
      } catch (e) {
        return null;
      }
    }
    try {
      return localStorage.getItem((shared ? "br_shared_" : "br_") + key);
    } catch (e) {
      return null;
    }
  }
  async function stSet(key, value, shared) {
    const v = typeof value === "string" ? value : JSON.stringify(value);
    if (hasWidgetStorage) {
      try {
        await window.storage.set(key, v, !!shared);
        return true;
      } catch (e) {
        /* fall through to localStorage as a backup */
      }
    }
    try {
      localStorage.setItem((shared ? "br_shared_" : "br_") + key, v);
      return true;
    } catch (e) {
      return false;
    }
  }
  async function stDelete(key, shared) {
    if (hasWidgetStorage) {
      try {
        await window.storage.delete(key, !!shared);
      } catch (e) {
        /* ignore */
      }
    }
    try {
      localStorage.removeItem((shared ? "br_shared_" : "br_") + key);
    } catch (e) {
      /* ignore */
    }
  }

  /* ---------------- crypto helpers ---------------- */
  function randSalt() {
    const arr = new Uint8Array(16);
    (window.crypto || window.msCrypto).getRandomValues(arr);
    return Array.from(arr)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
  async function sha256Hex(str) {
    if (window.crypto && window.crypto.subtle && window.crypto.subtle.digest) {
      const buf = await window.crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(str)
      );
      return Array.from(new Uint8Array(buf))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    }
    // extremely small fallback if SubtleCrypto is unavailable (very old/insecure browsers)
    let h = 0;
    for (let i = 0; i < str.length; i++) {
      h = (h << 5) - h + str.charCodeAt(i);
      h |= 0;
    }
    return "fb" + Math.abs(h).toString(16);
  }
  async function hashPassword(password, salt) {
    let val = salt + ":" + password;
    for (let i = 0; i < 2000; i++) {
      val = await sha256Hex(val + salt);
    }
    return val;
  }

  function normEmail(e) {
    return String(e || "").trim().toLowerCase();
  }
  function userKey(email) {
    return "user:" + normEmail(email);
  }

  /* ---------------- user records (shared) ---------------- */
  async function findUser(email) {
    const raw = await stGet(userKey(email), true);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }
  async function saveUser(user) {
    await stSet(userKey(user.email), user, true);
  }
  function publicUser(user) {
    return {
      name: user.name,
      email: user.email,
      plan: user.plan || "Free",
      provider: user.provider || "password",
      createdAt: user.createdAt,
    };
  }

  /* ---------------- session (personal) ---------------- */
  async function setSession(email) {
    await stSet("session", { email: normEmail(email), guest: false, ts: Date.now() }, false);
  }
  async function getSession() {
    const raw = await stGet("session", false);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }
  async function logout() {
    await stDelete("session", false);
  }
  async function loginGuest() {
    await stSet("session", { guest: true, ts: Date.now() }, false);
  }

  /* ---------------- public actions ---------------- */
  async function register({ name, email, password, confirmPassword }) {
    name = String(name || "").trim();
    email = normEmail(email);

    if (!name || !email || !password) {
      throw new Error("Please fill in your name, email and password.");
    }
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      throw new Error("Please enter a valid email address.");
    }
    if (password.length < 6) {
      throw new Error("Password must be at least 6 characters.");
    }
    if (confirmPassword !== undefined && password !== confirmPassword) {
      throw new Error("Passwords do not match.");
    }
    const existing = await findUser(email);
    if (existing) {
      throw new Error("An account with this email already exists — try signing in instead.");
    }
    const salt = randSalt();
    const passwordHash = await hashPassword(password, salt);
    const user = {
      name,
      email,
      salt,
      passwordHash,
      plan: "Free",
      provider: "password",
      createdAt: new Date().toISOString(),
    };
    await saveUser(user);
    await setSession(email);
    return publicUser(user);
  }

  async function login(email, password) {
    email = normEmail(email);
    if (!email || !password) throw new Error("Please enter both email and password.");
    const user = await findUser(email);
    if (!user) throw new Error("No account found for that email — try registering first.");
    const hash = await hashPassword(password, user.salt);
    if (hash !== user.passwordHash) throw new Error("Incorrect password. Please try again.");
    await setSession(email);
    return publicUser(user);
  }

  async function currentUser() {
    const s = await getSession();
    if (!s || s.guest) return null;
    const user = await findUser(s.email);
    return user ? publicUser(user) : null;
  }

  async function updateProfile({ name }) {
    const s = await getSession();
    if (!s || s.guest) throw new Error("You must be signed in to update your account.");
    const user = await findUser(s.email);
    if (!user) throw new Error("Account not found.");
    if (name !== undefined && String(name).trim()) user.name = String(name).trim();
    await saveUser(user);
    return publicUser(user);
  }

  async function changePassword(currentPassword, newPassword, confirmNewPassword) {
    const s = await getSession();
    if (!s || s.guest) throw new Error("You must be signed in to change your password.");
    const user = await findUser(s.email);
    if (!user) throw new Error("Account not found.");
    const hash = await hashPassword(currentPassword || "", user.salt);
    if (hash !== user.passwordHash) throw new Error("Current password is incorrect.");
    if (!newPassword || newPassword.length < 6) {
      throw new Error("New password must be at least 6 characters.");
    }
    if (confirmNewPassword !== undefined && newPassword !== confirmNewPassword) {
      throw new Error("New passwords do not match.");
    }
    const salt = randSalt();
    user.salt = salt;
    user.passwordHash = await hashPassword(newPassword, salt);
    await saveUser(user);
    return true;
  }

  async function setPremiumDemo(isPremium) {
    const s = await getSession();
    if (!s || s.guest) throw new Error("Sign in first.");
    const user = await findUser(s.email);
    if (!user) throw new Error("Account not found.");
    user.plan = isPremium ? "Premium" : "Free";
    await saveUser(user);
    return publicUser(user);
  }

  /* ---------------- page guards ---------------- */
  async function requireAuth(redirectTo) {
    redirectTo = redirectTo || "login.html";
    const s = await getSession();
    if (!s) {
      location.replace(redirectTo);
      return null;
    }
    if (s.guest) return { guest: true, name: "Guest User", email: "", plan: "Free" };
    const user = await currentUser();
    if (!user) {
      await logout();
      location.replace(redirectTo);
      return null;
    }
    return user;
  }

  async function redirectIfLoggedIn(redirectTo) {
    redirectTo = redirectTo || "blackroad-dashboard.html";
    const s = await getSession();
    if (s) location.replace(redirectTo);
  }

  global.BRAuth = {
    register,
    login,
    loginGuest,
    logout,
    getSession,
    currentUser,
    updateProfile,
    changePassword,
    setPremiumDemo,
    requireAuth,
    redirectIfLoggedIn,
    normEmail,
  };
})(window);
