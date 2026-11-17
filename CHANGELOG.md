# Changelog

The notes of every release. The release workflow copies the section of the tagged version into
the GitHub release, and the app shows those notes before it installs an update.

## 0.6.3

- The title bar is one row across the window now. Nothing crosses it: the sidebar's right border
  starts at the bar's bottom line instead of cutting through it, and on macOS the window's
  traffic lights keep their own room at the left, whatever the navigator does.
- The brand moved to the top of the sidebar's column: the mark and the wordmark when the sidebar
  is open, the mark alone when it collapses to the icon rail.
- The check for updates left the empty state and stands in the sidebar's footer next to the
  version, so it is there with a cluster connected too.

## 0.6.2

- The title bar starts with the brand now. The brand sits in a column as wide as the navigator,
  and the divider between it and the rest of the bar continues the panel's border: the two cannot
  drift apart when the panel collapses to a rail. Collapsed, the column is as narrow as the rail
  and holds the mark alone.
- The bar reads left to right: the brand, the cluster and namespace pickers, the search field in
  the middle, and the session's actions on the right.
- The pickers lost their borders and gained the icons the bar reads better with, the server's
  version sits in a chip, and the session's state says what it is instead of a bare dot.
- On macOS the window's traffic lights own the bar's left corner, so there the mark moves into
  the rail when the navigator is collapsed.

## 0.6.1

- The MSI carries the icon again. The .ico files held PNG images, and the Windows Installer
  reads the icon out of an MSI with the old icon API, which cannot decode a PNG: it fell back to
  the generic installer icon. The icons now carry BMP payloads, which is what the installer, the
  app and the Windows shell all read.
- The title bar has no navigator button any more: the navigator collapses from its own footer,
  next to the version. The brand in the middle of the title bar no longer changes when the
  navigator collapses, so it stays where it is instead of swapping itself for a letter.
- The version moved to the navigator's footer and comes from the bundle, so it is the version
  that is actually running.
- The site's badge takes the version and the headline from the published release, so it cannot
  fall behind the release it points at.
- The title bar's controls are all the same height now.

## 0.6.0

- The YAML editor works again. The built app gave the page a content-security nonce, and a nonce
  makes `'unsafe-inline'` ineffective, so the styles CodeMirror injects at runtime were refused:
  the Create dialog's editor lost its layout (the line numbers stood above the text instead of
  beside it), its colours and its font. The page carries no inline style now, and the editor
  takes the nonce with it if one ever appears again.
- The brand sits in the middle of the title bar, and the navigator no longer runs under the
  window's traffic lights: on macOS the collapsed rail no longer draws a line through them.
- With the navigator collapsed the brand shrinks to the letter alone.
- The cluster list moved to the title bar: the button that shows the connected cluster opens a menu
  of your kubeconfig contexts, with **Add kubeconfig…** as its last entry. With no kubeconfig at all
  the button says **Add kubeconfig** itself. The navigator keeps the resource tree alone, and the
  title bar carries its own button to collapse and expand it.
- The navigator's empty space shows the version and a **Check for updates** button.
- An update shows its release notes before the install button.
- The Windows installer wears the app's own dark theme instead of the default NSIS wizard.
- The first run on Linux greets with the brand instead of a bare window.
- The installer's icon and the Linux desktop entry carry the flat mark.
- The graph canvas loads on demand: the main bundle shrank from 613 kB to 420 kB.
- The build runs on macOS, Windows and Linux, and the coverage thresholds are a ratchet in CI.
- The IPC contract and the specs now say what the code does.

## 0.5.1

- The Cutout mark replaces the old logo everywhere: the title bar, the installer and the site.
- The documentation site moved to its own repository.

## 0.5.0

- Several namespaces at once, with a scope picker that remembers what you chose.
- The details panel gained logs, a container terminal and the object's history.
- Helm releases are browsable next to the workloads.

## 0.4.0

- A container terminal per pod.
- NetworkPolicies, RBAC objects and Nodes are first-class kinds.
- Custom resources and Helm charts have their own views.

## 0.3.0

- Rollout actions: scale, restart, roll back and forward a workload.
- Port-forwarding with a port that is picked for you.
- Live logs and cluster metrics.
- Automatic updates, signed with a separate updater key.

## 0.2.0

- The Doppler theme: the app, the README screenshots and the documentation site.
