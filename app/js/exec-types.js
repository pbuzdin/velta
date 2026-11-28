// Which attachment names would start a program (or something that runs one)
// when the system opens them. Desktop "Open" asks first for these.
// Pure and DOM-free: tested in node.

const KINDS = {
  program: "exe com scr pif msi msp msix msixbundle appx appxbundle appinstaller application gadget cpl jar jnlp app bin run appimage elf out",
  script: "bat cmd ps1 ps1xml psm1 psd1 vbs vbe js jse wsf wsh ws sct hta reg inf sh bash zsh csh ksh fish command tool py pyw pl rb php scpt scptd osa workflow action",
  shortcut: "lnk url scf desktop webloc library-ms searchconnector-ms settingcontent-ms appref-ms",
  package: "pkg deb rpm dmg chm msc prefpane saver terminal",
};

const KIND_BY_EXT = new Map();
for (const [kind, list] of Object.entries(KINDS)) {
  for (const ext of list.split(" ")) KIND_BY_EXT.set(ext, kind);
}

/** Lowercased last extension, the way Windows resolves it: trailing dots and
 *  spaces are ignored ("a.exe. " is "a.exe"), a path prefix is dropped. */
export function fileExtension(name) {
  const base = String(name ?? "").split(/[\\/]/).pop().replace(/[.  ]+$/, "");
  const i = base.lastIndexOf(".");
  return i > 0 || (i === 0 && base.length > 1) ? base.slice(i + 1).toLowerCase() : "";
}

/** "program" | "script" | "shortcut" | "package", or null for a plain document. */
export function executableKind(name) {
  return KIND_BY_EXT.get(fileExtension(name)) || null;
}

export function isExecutableName(name) {
  return executableKind(name) !== null;
}
