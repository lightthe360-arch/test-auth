
require("dotenv").config();

const crypto = require("node:crypto");
const path = require("node:path");
const express = require("express");
const session = require("express-session");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

const {
  Client,
  GatewayIntentBits,
  PermissionFlagsBits
} = require("discord.js");

const required = [
  "CLIENT_ID",
  "CLIENT_SECRET",
  "BOT_TOKEN",
  "GUILD_ID",
  "SESSION_SECRET",
  "BASE_URL"
];

const missing = required.filter((key) => !process.env[key]);

if (missing.length) {
  console.error(
    `Missing required environment variables: ${missing.join(", ")}`
  );
  process.exit(1);
}

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const BOT_TOKEN = process.env.BOT_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const SESSION_SECRET = process.env.SESSION_SECRET;
const BASE_URL = process.env.BASE_URL.replace(/\/+$/, "");
const ADMIN_ROLE_ID = process.env.ADMIN_ROLE_ID || "";
const PORT = Number(process.env.PORT || 3000);
const IS_PRODUCTION = process.env.NODE_ENV === "production";

const app = express();

if (IS_PRODUCTION) {
  app.set("trust proxy", 1);
}

app.disable("x-powered-by");

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: [
          "'self'",
          "'unsafe-inline'",
          "https://fonts.googleapis.com"
        ],
        fontSrc: [
          "'self'",
          "https://fonts.gstatic.com",
          "data:"
        ],
        imgSrc: [
          "'self'",
          "https://cdn.discordapp.com",
          "https://media.discordapp.net",
          "data:"
        ],
        scriptSrc: ["'self'"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        upgradeInsecureRequests: IS_PRODUCTION ? [] : null
      }
    }
  })
);

app.use(express.json({ limit: "50kb" }));

app.use(
  session({
    name: "discord_dashboard_sid",
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: IS_PRODUCTION,
      sameSite: "lax",
      maxAge: 1000 * 60 * 60 * 24 * 7
    }
  })
);

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 90,
  standardHeaders: true,
  legacyHeaders: false
});

const bot = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers
  ]
});

let botReady = false;

bot.once("ready", () => {
  botReady = true;
  console.log(`Discord bot logged in as ${bot.user.tag}`);
});

bot.on("error", (error) => {
  console.error("Discord client error:", error);
});

async function getGuild() {
  if (!botReady) {
    throw new Error(
      "De Discord-bot is nog niet klaar. Probeer het zo opnieuw."
    );
  }

  return bot.guilds.fetch(GUILD_ID);
}

function safeUser(user) {
  const avatar = user.avatar
    ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${user.avatar.startsWith("a_") ? "gif" : "png"}?size=256`
    : `https://cdn.discordapp.com/embed/avatars/${Number(BigInt(user.id) >> 22n) % 6}.png`;

  return {
    id: user.id,
    username: user.username,
    globalName: user.global_name || user.globalName || user.username,
    avatar
  };
}

function safeRole(role) {
  return {
    id: role.id,
    name: role.name,
    color: role.hexColor,
    position: role.position,
    isEveryone: role.id === role.guild.id
  };
}

function requireLogin(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({
      error: "Log eerst in met Discord."
    });
  }

  next();
}

async function currentMember(req) {
  const guild = await getGuild();

  const member = await guild.members
    .fetch(req.session.user.id)
    .catch(() => null);

  return { guild, member };
}

async function requireDirectoryAccess(req, res, next) {
  try {
    const { member } = await currentMember(req);

    if (!member) {
      return res.status(403).json({
        error: "Je moet lid zijn van de gekoppelde Discord-server."
      });
    }

    const hasConfiguredRole =
      ADMIN_ROLE_ID &&
      member.roles.cache.has(ADMIN_ROLE_ID);

    const isAdmin = member.permissions.has(
      PermissionFlagsBits.Administrator
    );

    if (!hasConfiguredRole && !isAdmin) {
      return res.status(403).json({
        error:
          "Alleen serverbeheerders of de ingestelde beheerrol mogen de ledenlijst bekijken."
      });
    }

    next();
  } catch (error) {
    console.error("Directory permission check failed:", error);

    res.status(503).json({
      error: "De Discord-server is tijdelijk niet bereikbaar."
    });
  }
}

// Controle of de website en bot draaien.
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    botReady
  });
});

// Start Discord OAuth2.
app.get("/auth/discord", loginLimiter, (req, res, next) => {
  req.session.oauthState = crypto.randomBytes(32).toString("hex");

  req.session.save((error) => {
    if (error) return next(error);

    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      response_type: "code",
      redirect_uri: `${BASE_URL}/auth/discord/callback`,
      scope: "identify",
      state: req.session.oauthState,
      prompt: "consent"
    });

    res.redirect(
      `https://discord.com/oauth2/authorize?${params.toString()}`
    );
  });
});

// Verwerk de OAuth2-callback.
app.get(
  "/auth/discord/callback",
  loginLimiter,
  async (req, res) => {
    const { code, state, error } = req.query;

    if (error) {
      return res.redirect("/?login=cancelled");
    }

    const expectedState = req.session.oauthState;
    delete req.session.oauthState;

    if (
      typeof state !== "string" ||
      typeof expectedState !== "string" ||
      state.length !== expectedState.length ||
      !crypto.timingSafeEqual(
        Buffer.from(state),
        Buffer.from(expectedState)
      )
    ) {
      return res.status(400).send(
        "Ongeldige OAuth state. Ga terug en probeer opnieuw in te loggen."
      );
    }

    if (typeof code !== "string") {
      return res.status(400).send(
        "Discord heeft geen autorisatiecode teruggestuurd."
      );
    }

    try {
      const tokenResponse = await fetch(
        "https://discord.com/api/v10/oauth2/token",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded"
          },
          body: new URLSearchParams({
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            grant_type: "authorization_code",
            code,
            redirect_uri: `${BASE_URL}/auth/discord/callback`
          })
        }
      );

      const tokenData = await tokenResponse.json();

      if (!tokenResponse.ok || !tokenData.access_token) {
        console.error(
          "OAuth token exchange failed:",
          tokenData.error || tokenResponse.status
        );

        return res.status(401).send(
          "Discord-login is mislukt. Controleer je OAuth2-instellingen."
        );
      }

      const userResponse = await fetch(
        "https://discord.com/api/v10/users/@me",
        {
          headers: {
            Authorization: `Bearer ${tokenData.access_token}`
          }
        }
      );

      const userData = await userResponse.json();

      if (!userResponse.ok || !userData.id) {
        return res.status(401).send(
          "Je Discord-account kon niet worden opgehaald."
        );
      }

      // Bewaar alleen de gebruikersgegevens, niet de OAuth-access-token.
      req.session.user = safeUser(userData);

      req.session.save((saveError) => {
        if (saveError) {
          return res.status(500).send(
            "Je sessie kon niet worden opgeslagen."
          );
        }

        res.redirect("/dashboard");
      });
    } catch (error) {
      console.error("OAuth callback error:", error);

      res.status(502).send(
        "Discord is tijdelijk niet bereikbaar. Probeer het later opnieuw."
      );
    }
  }
);

// Uitloggen.
app.post("/auth/logout", (req, res, next) => {
  req.session.destroy((error) => {
    if (error) return next(error);

    res.clearCookie("discord_dashboard_sid", {
      httpOnly: true,
      secure: IS_PRODUCTION,
      sameSite: "lax"
    });

    res.json({ ok: true });
  });
});

// Eigen profiel, server en rollen.
app.get(
  "/api/me",
  apiLimiter,
  requireLogin,
  async (req, res) => {
    try {
      const { guild, member } = await currentMember(req);

      if (!member) {
        return res.json({
          user: req.session.user,
          server: {
            id: guild.id,
            name: guild.name,
            icon: guild.iconURL({ size: 256 })
          },
          roles: [],
          inServer: false,
          canViewMembers: false
        });
      }

      const roles = member.roles.cache
        .filter((role) => role.id !== guild.id)
        .sort((a, b) => b.position - a.position)
        .map(safeRole);

      const hasConfiguredRole =
        ADMIN_ROLE_ID &&
        member.roles.cache.has(ADMIN_ROLE_ID);

      const isAdmin = member.permissions.has(
        PermissionFlagsBits.Administrator
      );

      res.set("Cache-Control", "no-store");

      res.json({
        user: req.session.user,
        server: {
          id: guild.id,
          name: guild.name,
          icon: guild.iconURL({ size: 256 })
        },
        roles,
        inServer: true,
        canViewMembers: Boolean(hasConfiguredRole || isAdmin)
      });
    } catch (error) {
      console.error("Profile API error:", error);

      res.status(503).json({
        error:
          "De servergegevens konden niet worden geladen. Controleer of de bot online is en toegang heeft."
      });
    }
  }
);

// Ledenlijst: alleen toegankelijk voor beheerders of ingestelde rol.
app.get(
  "/api/members",
  apiLimiter,
  requireLogin,
  requireDirectoryAccess,
  async (req, res) => {
    try {
      const guild = await getGuild();

      const search = String(req.query.q || "")
        .trim()
        .toLowerCase()
        .slice(0, 80);

      const requestedLimit = Number.parseInt(
        String(req.query.limit || "100"),
        10
      );

      const limit = Number.isFinite(requestedLimit)
        ? Math.max(1, Math.min(requestedLimit, 200))
        : 100;

      // Vereist de Server Members Intent in Discord Developer Portal.
      const members = await guild.members.fetch();

      const results = members
        .map((member) => ({
          id: member.id,
          username: member.user.username,
          displayName: member.displayName,
          avatar: member.user.displayAvatarURL({ size: 128 }),
          roles: member.roles.cache
            .filter((role) => role.id !== guild.id)
            .sort((a, b) => b.position - a.position)
            .map((role) => ({
              id: role.id,
              name: role.name,
              color: role.hexColor
            }))
        }))
        .filter((member) => {
          if (!search) return true;

          return (
            member.username.toLowerCase().includes(search) ||
            member.displayName.toLowerCase().includes(search) ||
            member.id.includes(search)
          );
        })
        .sort((a, b) =>
          a.displayName.localeCompare(b.displayName)
        )
        .slice(0, limit);

      res.set("Cache-Control", "no-store");

      res.json({
        members: results,
        returned: results.length,
        limit,
        search
      });
    } catch (error) {
      console.error("Members API error:", error);

      res.status(503).json({
        error:
          "De ledenlijst kon niet worden opgehaald. Controleer de Server Members Intent en botrechten."
      });
    }
  }
);

// Websitebestanden serveren.
app.use(
  express.static(path.join(__dirname, "public"), {
    extensions: ["html"],
    etag: true,
    maxAge: IS_PRODUCTION ? "1h" : 0
  })
);

// Andere browserroutes openen de website.
app.get("*splat", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Algemene foutafhandeling.
app.use((error, _req, res, _next) => {
  console.error("Unhandled server error:", error);

  res.status(500).json({
    error: "Er is iets misgegaan op de server."
  });
});

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`Website listening on port ${PORT}`);
});

bot.login(BOT_TOKEN).catch((error) => {
  console.error(
    "Discord bot login failed. Check BOT_TOKEN:",
    error.message
  );
});

async function shutdown() {
  console.log("Shutting down...");

  server.close(() => {});
  bot.destroy();

  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
