
const $ = (id) => document.getElementById(id);

const loginView = $("loginView");
const dashboardView = $("dashboardView");
const logoutButton = $("logoutButton");
const loginFooter = $("loginFooter");
const notice = $("notice");

let memberSearchTimer;

function showNotice(message, isError = false) {
  notice.textContent = message;
  notice.classList.remove("hidden", "error");

  if (isError) notice.classList.add("error");
}

function hideNotice() {
  notice.classList.add("hidden");
  notice.textContent = "";
}

function escapeText(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[char]));
}

function setColor(color) {
  return /^#[0-9a-fA-F]{6}$/.test(color || "")
    ? color
    : "#8b5cf6";
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      ...(options.headers || {})
    },
    ...options
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      data.error || `Verzoek mislukt (${response.status}).`
    );
  }

  return data;
}

function renderRoles(roles) {
  $("roleCount").textContent = String(roles.length);

  const list = $("rolesList");

  if (!roles.length) {
    list.innerHTML =
      '<div class="empty-state">Er zijn geen extra rollen gevonden voor dit account.</div>';
    return;
  }

  list.innerHTML = roles.map((role) => `
    <span class="role-chip" title="${escapeText(role.name)}">
      <span class="role-dot"
        style="background:${setColor(role.color)}"></span>
      ${escapeText(role.name)}
    </span>
  `).join("");
}

function renderMembers(members, returned, search) {
  $("memberCount").textContent = String(returned);

  const list = $("membersList");

  if (!members.length) {
    list.innerHTML = `
      <p class="muted small">
        ${search
          ? "Geen leden gevonden voor deze zoekopdracht."
          : "Geen leden gevonden."}
      </p>
    `;
  } else {
    list.innerHTML = members.map((member) => {
      const roles = member.roles.length
        ? member.roles.slice(0, 5).map((role) => `
            <span class="member-role"
              style="color:${setColor(role.color)}">
              ${escapeText(role.name)}
            </span>
          `).join("")
        : '<span class="muted small">Geen extra rollen</span>';

      const more = member.roles.length > 5
        ? `<span class="member-role">+${member.roles.length - 5}</span>`
        : "";

      return `
        <div class="member-row">
          <img
            class="member-avatar"
            src="${escapeText(member.avatar)}"
            alt=""
            loading="lazy"
            referrerpolicy="no-referrer"
          >

          <div class="member-info">
            <b>${escapeText(member.displayName)}</b>
            <span>
              @${escapeText(member.username)}
              · ${escapeText(member.id)}
            </span>
          </div>

          <div class="member-roles">
            ${roles}${more}
          </div>
        </div>
      `;
    }).join("");
  }

  $("membersFooter").textContent =
    `Toont ${returned} lid${returned === 1 ? "" : "en"}` +
    `${search ? ` voor "${search}"` : ""}. ` +
    "Maximaal 200 resultaten per zoekopdracht.";
}

async function loadMembers(search = "") {
  const list = $("membersList");
  list.innerHTML = '<p class="muted small">Leden laden...</p>';

  try {
    const data = await api(
      `/api/members?q=${encodeURIComponent(search)}&limit=200`
    );

    renderMembers(data.members, data.returned, search);
  } catch (error) {
    list.innerHTML = `
      <p class="muted small">${escapeText(error.message)}</p>
    `;
  }
}

async function loadDashboard() {
  try {
    const data = await api("/api/me");

    loginView.classList.add("hidden");
    loginFooter.classList.add("hidden");
    dashboardView.classList.remove("hidden");
    logoutButton.classList.remove("hidden");

    hideNotice();

    $("userAvatar").src = data.user.avatar;
    $("userAvatar").alt = `${data.user.username} avatar`;

    $("userName").textContent =
      data.user.globalName || data.user.username;

    $("userId").textContent = `@${data.user.username}`;
    $("copyId").dataset.userId = data.user.id;

    $("serverName").textContent = data.server.name;

    $("serverIconFallback").textContent =
      (data.server.name || "G").slice(0, 1).toUpperCase();

    if (data.server.icon) {
      $("serverIcon").src = data.server.icon;
      $("serverIcon").classList.remove("hidden");
      $("serverIconFallback").classList.add("hidden");
    }

    $("botStatus").textContent = "Online";

    $("memberState").textContent = data.inServer
      ? "Je account is lid van deze server."
      : "Je bent nog geen lid van deze server. Vraag toegang aan bij de serverbeheerder.";

    renderRoles(data.roles || []);

    if (data.canViewMembers) {
      $("membersSection").classList.remove("hidden");
      loadMembers("");
    } else {
      $("membersSection").classList.add("hidden");
    }
  } catch (error) {
    loginView.classList.remove("hidden");
    dashboardView.classList.add("hidden");
    logoutButton.classList.add("hidden");

    if (
      new URLSearchParams(location.search).get("login") === "cancelled"
    ) {
      showNotice(
        "Je hebt het inloggen geannuleerd. Je kunt het opnieuw proberen."
      );
    } else if (
      error.message &&
      !error.message.includes("Log eerst in")
    ) {
      showNotice(error.message, true);
    }
  }
}

logoutButton.addEventListener("click", async () => {
  try {
    await api("/auth/logout", { method: "POST" });
  } catch (_) {
    // Ook bij een netwerkfout terug naar de loginpagina.
  }

  location.href = "/";
});

$("copyId").addEventListener("click", async () => {
  const id = $("copyId").dataset.userId;

  if (!id) return;

  try {
    await navigator.clipboard.writeText(id);
    $("copyId").textContent = "Gekopieerd!";

    setTimeout(() => {
      $("copyId").textContent = "Kopieer ID";
    }, 1500);
  } catch (_) {
    $("copyId").textContent = id;
  }
});

$("memberSearch").addEventListener("input", (event) => {
  clearTimeout(memberSearchTimer);

  const value = event.target.value.trim();

  memberSearchTimer = setTimeout(() => {
    loadMembers(value);
  }, 300);
});

const params = new URLSearchParams(location.search);

if (params.get("login") === "cancelled") {
  showNotice(
    "Je hebt het inloggen geannuleerd. Je kunt het opnieuw proberen."
  );
}

loadDashboard();

