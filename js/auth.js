// Auth + ruteo según rol.

import { sb, isConfigured } from "./supabase.js";
import { showView, setUserLabel, toast } from "./ui.js";
import { renderVendor } from "./vendor.js";
import { renderMaster } from "./master.js";

let currentProfile = null;

export function getProfile() { return currentProfile; }

export async function initAuth() {
  if (!isConfigured()) {
    showView("login");
    document.getElementById("login-error").hidden = false;
    document.getElementById("login-error").textContent =
      "Falta configurar SUPABASE_URL y SUPABASE_ANON_KEY en js/supabase.js.";
    return;
  }

  bindLoginForm();
  bindLogoutButton();

  const { data: { session } } = await sb.auth.getSession();
  await routeFor(session);

  // Solo re-ruteamos en cambios reales de sesion. TOKEN_REFRESHED ocurre
  // cuando la pestana vuelve al foco y rompe la vista (la deja en
  // "Cargando..." indefinidamente).
  sb.auth.onAuthStateChange((event, session) => {
    if (event === "SIGNED_IN" || event === "SIGNED_OUT") {
      routeFor(session);
    }
  });
}

function bindLoginForm() {
  const form = document.getElementById("login-form");
  if (!form) return;
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const errEl = document.getElementById("login-error");
    errEl.hidden = true;
    const email = form.elements.email.value.trim();
    const password = form.elements.password.value;
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) {
      errEl.textContent = error.message;
      errEl.hidden = false;
    }
  });
}

function bindLogoutButton() {
  const btn = document.getElementById("btn-logout");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    await sb.auth.signOut();
  });
}

async function routeFor(session) {
  if (!session?.user) {
    currentProfile = null;
    setUserLabel("");
    showView("login");
    return;
  }

  showView("loading");

  const { data, error } = await sb
    .from("profiles")
    .select("id, email, full_name, role, zone")
    .eq("id", session.user.id)
    .single();

  if (error || !data) {
    toast("No se pudo cargar tu perfil. Verifica que exista en la tabla profiles.", "error");
    await sb.auth.signOut();
    return;
  }

  currentProfile = data;
  setUserLabel(`${data.full_name || data.email} · ${data.role}`);

  if (data.role === "master") {
    showView("master");
    renderMaster();
  } else {
    showView("vendor");
    renderVendor();
  }
}
