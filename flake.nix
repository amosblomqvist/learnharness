# LearnHarness for NixOS (issue #76): wraps the published AppImage with
# nixpkgs appimageTools — nothing is built from source. The { version,
# sha512 } pin lives in nix/release.json and is refreshed per release by
# .github/workflows/nix-update.yml; the sha512 there is electron-builder's
# own base64 value from the release's latest-linux.yml, prefixed below into
# the SRI form Nix accepts. x86_64-linux only — that is the only AppImage
# the release pipeline publishes.
{
  description = "LearnHarness — AI-tutored learning desktop app (published AppImage, wrapped)";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};
      pname = "learnharness";
      release = builtins.fromJSON (builtins.readFile ./nix/release.json);
      src = pkgs.fetchurl {
        url = "https://github.com/amosblomqvist/learnharness/releases/download/v${release.version}/LearnHarness-${release.version}-x86_64.AppImage";
        hash = "sha512-${release.sha512}";
      };
    in
    {
      packages.${system}.default = pkgs.appimageTools.wrapType2 {
        inherit pname src;
        inherit (release) version;
        # Electron runtime libs beyond the FHS sandbox's defaults. Trim or
        # extend from real NixOS runs if anything proves missing.
        extraPkgs = pkgs: with pkgs; [ alsa-lib gtk3 nss ];
        extraInstallCommands = ''
          # Nix owns the installed files (read-only store): the built-in
          # updater could never replace them — turn it off (issue #76; see
          # docs/desktop-release.md → NixOS).
          wrapProgram $out/bin/${pname} --set LH_DISABLE_AUTOUPDATER 1
        '';
        meta = {
          description = "AI agents that measure, plan, and teach lessons from your current understanding to your goal";
          homepage = "https://learnharness.ai";
          license = nixpkgs.lib.licenses.agpl3Only;
          mainProgram = pname;
          platforms = [ "x86_64-linux" ];
        };
      };
    };
}
