# Code signing

Wiring's installers are built by the [release workflow](../.github/workflows/release.yml). Without signing, macOS Gatekeeper blocks the app and Windows SmartScreen warns about an unknown publisher. The workflow signs a build when the secrets below are set, and builds unsigned (with a notice in the run log) when they are not. You can set up the two platforms independently.

| Platform | What you need | Cost |
|---|---|---|
| macOS | An [Apple Developer Program](https://developer.apple.com/programs/) membership, a **Developer ID Application** certificate, and notarization | $99 a year |
| Windows | An [Azure Artifact Signing](https://learn.microsoft.com/azure/artifact-signing/) account (formerly Trusted Signing) | Basic tier, about $10 a month |

Windows signing uses Azure Artifact Signing. Since June 2023, code-signing certificates must keep their private key in a hardware module, so a certificate can no longer be exported as a `.pfx` file for CI. Artifact Signing keeps the key in Azure and signs from CI with an app registration.

> **Who can get an Artifact Signing certificate.** Public Trust certificates are issued to organisations in the United States, Canada, the EU, the UK, Australia, New Zealand, Japan, South Korea, Singapore, Switzerland, Norway and Israel. Individual developers must be in the United States or Canada ([quickstart prerequisites](https://learn.microsoft.com/azure/artifact-signing/quickstart#prerequisites)).
>
> If you are not eligible, buy an OV or EV code-signing certificate from a CA that offers cloud signing, such as SSL.com eSigner or DigiCert KeyLocker. Then replace the `signCommand` written by the *Configure Windows signing* step in the workflow with that CA's signing tool. Tauri runs whatever command you give it, with `%1` replaced by the file to sign.

## macOS

### 1. Create the certificate

1. In [Certificates, IDs & Profiles](https://developer.apple.com/account/resources/certificates/list), create a **Developer ID Application** certificate. The request comes from *Keychain Access → Certificate Assistant → Request a Certificate From a Certificate Authority*.
2. Download it and double-click to add it to your login keychain.
3. In Keychain Access, find it under *My Certificates*, right-click it, choose **Export**, and save it as `certificate.p12` with a password.
4. Find its signing identity:

   ```bash
   security find-identity -v -p codesigning
   # 1) ABC123… "Developer ID Application: Your Name (TEAMID1234)"
   ```

### 2. Create a password for notarization

Notarization sends the app to Apple for an automated check. Gatekeeper opens a notarized app without a warning.

1. At [account.apple.com](https://account.apple.com), under *Sign-In and Security → App-Specific Passwords*, create a password for "Wiring notarization".
2. Your Team ID is shown under *Membership details* at [developer.apple.com/account](https://developer.apple.com/account).

### 3. Add the secrets

In the repository, go to *Settings → Secrets and variables → Actions → New repository secret*. Or use `gh`:

```bash
gh secret set APPLE_CERTIFICATE < <(base64 -i certificate.p12)
gh secret set APPLE_CERTIFICATE_PASSWORD          # the .p12 export password
gh secret set APPLE_SIGNING_IDENTITY --body "Developer ID Application: Your Name (TEAMID1234)"
gh secret set APPLE_ID --body "you@example.com"
gh secret set APPLE_PASSWORD                      # the app-specific password
gh secret set APPLE_TEAM_ID --body "TEAMID1234"
```

| Secret | Value |
|---|---|
| `APPLE_CERTIFICATE` | The `.p12` file, base64-encoded |
| `APPLE_CERTIFICATE_PASSWORD` | The password you exported the `.p12` with |
| `APPLE_SIGNING_IDENTITY` | The full identity string from `security find-identity` |
| `APPLE_ID` | Your Apple Account email |
| `APPLE_PASSWORD` | The app-specific password, not your Apple Account password |
| `APPLE_TEAM_ID` | Your 10-character Team ID |

If the three notarization secrets are missing, the app is signed but not notarized. Gatekeeper still blocks such an app, and the run log shows a warning.

## Windows

### 1. Set up Azure Artifact Signing

These steps follow Microsoft's [quickstart](https://learn.microsoft.com/azure/artifact-signing/quickstart):

1. In the Azure portal, create an **Artifact Signing account**. Note its region endpoint, for example `https://eus.codesigning.azure.net`.
2. Complete **identity validation** for yourself or your organisation. This can take a few days.
3. Create a **certificate profile** of type *Public Trust*.
4. In *Microsoft Entra ID → App registrations*, create an app registration for CI. Add a **client secret**, and note the *Application (client) ID* and the *Directory (tenant) ID*.
5. On the signing account, under *Access control (IAM)*, give that app the **Artifact Signing Certificate Profile Signer** role.

### 2. Add the secrets and variables

```bash
gh secret set AZURE_CLIENT_ID --body "<application (client) id>"
gh secret set AZURE_CLIENT_SECRET                 # the client secret value
gh secret set AZURE_TENANT_ID --body "<directory (tenant) id>"
gh variable set AZURE_SIGNING_ENDPOINT --body "https://eus.codesigning.azure.net"
gh variable set AZURE_SIGNING_ACCOUNT --body "<signing account name>"
gh variable set AZURE_SIGNING_PROFILE --body "<certificate profile name>"
```

| Name | Kind | Value |
|---|---|---|
| `AZURE_CLIENT_ID` | secret | The app registration's client ID |
| `AZURE_CLIENT_SECRET` | secret | The app registration's client secret |
| `AZURE_TENANT_ID` | secret | Your Entra tenant ID |
| `AZURE_SIGNING_ENDPOINT` | variable | The signing account's regional endpoint |
| `AZURE_SIGNING_ACCOUNT` | variable | The signing account name |
| `AZURE_SIGNING_PROFILE` | variable | The certificate profile name |

The workflow installs [`trusted-signing-cli`](https://github.com/Levminer/trusted-signing-cli). It then points Tauri's `bundle.windows.signCommand` at that tool, so the app executable and both installers (`.msi` and `-setup.exe`) are signed.

## Checking a setup before a release

Run the workflow by hand. It builds and signs exactly as a release does, but uploads the installers as workflow artifacts instead of creating a release:

```bash
gh workflow run release.yml
gh run watch                      # then: gh run download <run-id>
```

The run log states for each platform whether the build was signed, and whether it was notarized.

Verify the downloaded installers:

```bash
# macOS
hdiutil attach Wiring_*_universal.dmg
codesign -dv --verbose=4 /Volumes/Wiring/Wiring.app    # Authority=Developer ID Application: …
spctl -a -vv /Volumes/Wiring/Wiring.app                # accepted, source=Notarized Developer ID
xcrun stapler validate Wiring_*_universal.dmg
```

```powershell
# Windows (PowerShell)
Get-AuthenticodeSignature .\Wiring_*_x64-setup.exe | Format-List Status, SignerCertificate
```

Once signing works, the first-launch workarounds in the [README's install table](../README.md#install) (`xattr`, *Run anyway*) are no longer needed. Update that table for the first signed release.
