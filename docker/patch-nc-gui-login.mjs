#!/usr/bin/env node
/**
 * Let the sign-in form accept a bare username (no "@") — needed when LDAP
 * users sign in with their uid rather than their mail address.
 *
 * The form is served from the prebuilt `nc-lib-gui` package, so the two things
 * that reject a non-email value live in its compiled bundle:
 *
 *   1. the input is rendered with type="email", and the browser refuses to
 *      submit a form whose email input isn't a valid address;
 *   2. the `email` field carries a validator wrapping the SDK's email check,
 *      which rejects anything without an "@".
 *
 * Both are relaxed here: the input becomes type="text" and the validator's
 * format check is dropped (the `required` rule stays, so empty input still
 * fails). The server side is untouched — NocoDB passes whatever was typed
 * straight to the LDAP search filter.
 *
 * Usage: node patch-nc-gui-login.mjs <node_modules-dir> [more dirs...]
 *
 * Any bundle it cannot recognise fails the build on purpose: a GUI bump that
 * renames things must be looked at, not silently shipped unpatched.
 */
import fs from 'node:fs';
import path from 'node:path';

const roots = process.argv.slice(2);
if (!roots.length) {
  console.error('usage: patch-nc-gui-login.mjs <node_modules-dir> [...]');
  process.exit(2);
}

// Data-testid on the sign-in email input — stable across GUI builds, unlike
// the minified identifiers around it.
const MARKER = 'nc-form-signin__email';

// Only the GUI's dist is of interest, so look for it exactly where the layouts
// put it instead of walking every package in the store (pnpm's .pnpm holds
// hundreds of thousands of files).
function distDirs(root) {
  // A node_modules directory holds nc-lib-gui directly; a project or workspace
  // root holds it a level below. Cover both, so the script works against the
  // repo as well as inside the image.
  const bases = new Set([root, path.join(root, 'node_modules')]);

  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (entry.name === '.pnpm') {
      // pnpm's content store: .pnpm/nc-lib-gui@<version>/node_modules/...
      let stored;
      try {
        stored = fs.readdirSync(path.join(root, entry.name));
      } catch {
        continue;
      }
      for (const pkg of stored) {
        if (pkg.startsWith('nc-lib-gui@')) {
          bases.add(path.join(root, entry.name, pkg, 'node_modules'));
        }
      }
    } else if (!entry.name.startsWith('.')) {
      // Workspace layout: <root>/<package>/node_modules/nc-lib-gui/...
      bases.add(path.join(root, entry.name, 'node_modules'));
    }
  }

  return [...bases].map((base) => path.join(base, 'nc-lib-gui/lib/dist/_nuxt'));
}

const targets = [];
const seen = new Set();
for (const root of roots) {
  const abs = path.resolve(root);
  if (!fs.existsSync(abs)) continue;
  for (const dir of distDirs(abs)) {
    let files;
    try {
      files = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith('.js')) continue;
      const full = path.join(dir, file);
      // Several trees link the same file — patch it once.
      let real;
      try {
        real = fs.realpathSync(full);
      } catch {
        continue;
      }
      if (seen.has(real)) continue;

      const source = fs.readFileSync(full, 'utf8');
      if (!source.includes(MARKER)) continue;
      seen.add(real);
      targets.push({ path: full, source });
    }
  }
}

if (!targets.length) {
  console.error(
    `patch-nc-gui-login: no nc-lib-gui chunk containing ${MARKER} under: ${roots.join(', ')}`,
  );
  process.exit(1);
}

for (const target of targets) {
  let patched = target.source;

  // 1. type="email" -> type="text" on the sign-in input.
  const emailInputs = patched.split('type:"email"').length - 1;
  if (emailInputs === 0 && patched.includes('||true)return')) {
    console.log(`patch-nc-gui-login: already patched, skipping ${target.path}`);
    continue;
  }
  if (emailInputs !== 1) {
    console.error(
      `patch-nc-gui-login: expected exactly one type:"email" in ${target.path}, found ${emailInputs}`,
    );
    process.exit(1);
  }
  patched = patched.replace('type:"email"', 'type:"text"');

  // 2. Drop the email-format check from the field's validator, keeping the
  //    required rule: `if (!value?.length || <isEmail>(value.trim())) resolve()`
  //    becomes `... || true)`, so any non-empty value passes.
  const anchor = patched.indexOf('signUpRules.emailRequired');
  if (anchor === -1) {
    console.error(
      `patch-nc-gui-login: no email rule found in ${target.path}`,
    );
    process.exit(1);
  }
  const window = patched.slice(anchor, anchor + 500);
  const formatCheck = window.match(/\|\|[A-Za-z_$][\w$]*\([A-Za-z_$][\w$]*\.trim\(\)\)/);
  if (!formatCheck) {
    console.error(
      `patch-nc-gui-login: email validator shape changed in ${target.path} — review the bundle before patching`,
    );
    process.exit(1);
  }
  patched =
    patched.slice(0, anchor) +
    window.replace(formatCheck[0], '||true') +
    patched.slice(anchor + 500);

  fs.writeFileSync(target.path, patched);
  console.log(`patch-nc-gui-login: patched ${target.path}`);
}
