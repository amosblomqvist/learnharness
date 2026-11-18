{
  description = "LearnHarness - An agent harness for learning";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = {
    self,
    nixpkgs,
    flake-utils,
  }: let
    systems = flake-utils.lib.defaultSystems;
  in
    flake-utils.lib.eachSystem systems (system: let
      pkgs = import nixpkgs {
        inherit system;
        config.allowUnfree = true;
      };
      lib = pkgs.lib;
      nodejs = pkgs.nodejs_24;
      electron = pkgs.electron_44;

      runtimeDeps = with pkgs; [
        nodejs
        electron
        git
      ];

      desktopItem = pkgs.makeDesktopItem {
        name = "learnharness";
        desktopName = "LearnHarness";
        comment = "An agent harness for learning: adaptive teaching, practice, and a persistent knowledge graph";
        exec = "learnharness %U";
        icon = "learnharness";
        terminal = false;
        categories = ["Education" "Development"];
        startupWMClass = "LearnHarness";
      };

      # Hermetically emit type declarations for plugins that declare learnharness-plugin-api
      pluginSdk = pkgs.buildNpmPackage {
        pname = "learnharness-plugin-sdk";
        version = "0.1.0";
        src = lib.cleanSource ./.;
        npmDepsHash = "sha256-bp7HWZaBNfuqtuguGxD4n1mtpTnMxRdqNvabxNMYRE8=";
        dontNpmBuild = true;
        installPhase = ''
          mkdir -p $out
          node scripts/build-plugin-types.mjs $out
        '';
      };

      # Build core plugin packages individually from source
      mkPlugin = {
        name,
        hash,
      }:
        pkgs.buildNpmPackage {
          pname = "learnharness-plugin-${name}";
          version = "0.1.0";
          src = lib.cleanSource (./plugins + "/${name}");
          npmDepsHash = hash;

          postPatch = ''
            if [ -f package.json ] && grep -q '"learnharness-plugin-api"' package.json; then
              cp -r ${pluginSdk} .sdk
            fi
          '';

          dontNpmBuild = true;

          buildPhase = ''
            node scripts/build.mjs
          '';

          installPhase = ''
            mkdir -p $out
            cp -r dist/* $out/
          '';
        };

      corePlugins = {
        flashcards = mkPlugin {
          name = "flashcards";
          hash = "sha256-AGjSn0TFK8jx3VpgAROg9fjhZ7gT6CKBD6vr+FbZJKE=";
        };
        drawingPad = mkPlugin {
          name = "drawing-pad";
          hash = "sha256-zMTb53SFM4ZQT30ktIu7s+DwqYL1QCN6Mg3ZtF5aCfw=";
        };
        codingQuestions = mkPlugin {
          name = "coding-questions";
          hash = "sha256-NWIHJiToak9X1qyMNSlZtMjyFatgIs0RHqmS0QcXzdo=";
        };
        richCodeBlocks = mkPlugin {
          name = "rich-code-blocks";
          hash = "sha256-/jyfBWOCuludfG1Hg3bXCUqMttXeABe0vt/paW5sSyY=";
        };
      };

      learnharnessPackage = pkgs.buildNpmPackage {
        pname = "learnharness";
        version = "0.6.1";
        src = lib.cleanSource ./.;

        npmDepsHash = "sha256-bp7HWZaBNfuqtuguGxD4n1mtpTnMxRdqNvabxNMYRE8=";

        nativeBuildInputs = [
          pkgs.copyDesktopItems
          pkgs.imagemagick
        ];

        desktopItems = [desktopItem];

        env = {
          NEXT_TELEMETRY_DISABLED = "1";
          ELECTRON_SKIP_BINARY_DOWNLOAD = "1";
        };

        postPatch = ''
          substituteInPlace app/layout.tsx \
            --replace 'import { JetBrains_Mono, Source_Sans_3 } from "next/font/google";' 'const JetBrains_Mono = (_opts?: unknown) => ({ variable: "--font-jetbrains" }); const Source_Sans_3 = (_opts?: unknown) => ({ variable: "--font-sans3" });'
        '';

        preBuild = ''
          # Stage local plugin API types for type checking
          mkdir -p node_modules/learnharness-plugin-api
          cp -r ${pluginSdk}/* node_modules/learnharness-plugin-api/

          # Hermetically stage validated core plugins built from source
          mkdir -p core-plugins
          cp -r ${corePlugins.flashcards} core-plugins/flashcards
          cp -r ${corePlugins.drawingPad} core-plugins/drawing-pad
          cp -r ${corePlugins.codingQuestions} core-plugins/coding-questions
          cp -r ${corePlugins.richCodeBlocks} core-plugins/rich-code-blocks
          export LH_PREBUILT_CORE_PLUGINS="1"
        '';

        postBuild = ''
          node scripts/build-server.mjs
        '';

        installPhase = ''
          runHook preInstall

          mkdir -p $out/bin
          mkdir -p $out/lib/learnharness
          mkdir -p $out/share/pixmaps
          mkdir -p $out/share/icons/hicolor/scalable/apps

          if [ -f build/icon.png ]; then
            cp build/icon.png $out/share/pixmaps/learnharness.png
            for size in 16 24 32 48 64 128 256 512; do
              mkdir -p $out/share/icons/hicolor/''${size}x''${size}/apps
              magick build/icon.png -resize ''${size}x''${size} $out/share/icons/hicolor/''${size}x''${size}/apps/learnharness.png
            done
          fi

          if [ -f build/icon-flat.svg ]; then
            cp build/icon-flat.svg $out/share/pixmaps/learnharness.svg
            cp build/icon-flat.svg $out/share/icons/hicolor/scalable/apps/learnharness.svg
          fi

          # Copy standalone Next.js server payload
          cp -r .next/standalone $out/lib/learnharness/server

          # Copy Electron entrypoint
          cp -r electron $out/lib/learnharness/electron
          cp package.json $out/lib/learnharness/package.json

          cat << EOF > $out/bin/learnharness
          #!/usr/bin/env bash
          export NODE_BIN="${nodejs}/bin/node"
          export LH_SERVER_ENTRY="$out/lib/learnharness/server/server.js"
          export ELECTRON_OVERRIDE_DIST_PATH="${electron}/bin"
          export ELECTRON_SKIP_BINARY_DOWNLOAD="1"
          export ELECTRON_OZONE_PLATFORM_HINT="auto"
          export PATH="${lib.makeBinPath runtimeDeps}:\$PATH"

          exec ${electron}/bin/electron "$out/lib/learnharness" "\$@"
          EOF
          chmod +x $out/bin/learnharness

          cat << 'EOF' > $out/bin/learnharness-dev
          #!/usr/bin/env bash
          export NODE_BIN="${nodejs}/bin/node"
          export ELECTRON_OVERRIDE_DIST_PATH="${electron}/bin"
          export ELECTRON_SKIP_BINARY_DOWNLOAD="1"
          export ELECTRON_OZONE_PLATFORM_HINT="auto"
          export PATH="${lib.makeBinPath runtimeDeps}:$PATH"

          CANDIDATES=(
            "$LEARNHARNESS_REPO"
            "$PWD"
            "$HOME/Documents/learnharness"
            "$HOME/Workspace/learnharness"
            "$HOME/Projects/learnharness"
          )

          TARGET_DIR=""
          for candidate in "''${CANDIDATES[@]}"; do
            if [ -n "$candidate" ] && [ -f "$candidate/package.json" ] && [ -f "$candidate/electron/main.cjs" ]; then
              TARGET_DIR="$candidate"
              break
            fi
          done

          if [ -n "$TARGET_DIR" ]; then
            cd "$TARGET_DIR"
            exec npm run desktop:dev "$@"
          else
            echo "Error: Could not locate LearnHarness repository directory."
            exit 1
          fi
          EOF
          chmod +x $out/bin/learnharness-dev

          runHook postInstall
        '';
      };
    in {
      packages = {
        default = learnharnessPackage;
        learnharness = learnharnessPackage;
      };

      apps = {
        default = {
          type = "app";
          program = "${learnharnessPackage}/bin/learnharness";
          meta.description = "Launch LearnHarness desktop application";
        };
        learnharness = {
          type = "app";
          program = "${learnharnessPackage}/bin/learnharness";
          meta.description = "Launch LearnHarness desktop application";
        };
        dev = {
          type = "app";
          program = "${learnharnessPackage}/bin/learnharness-dev";
          meta.description = "Launch LearnHarness external desktop development session";
        };
      };

      devShells.default = pkgs.mkShell {
        packages = with pkgs; [
          nodejs
          tsx
          electron
          pkg-config
        ];

        env = {
          ELECTRON_OVERRIDE_DIST_PATH = "${electron}/bin";
          ELECTRON_SKIP_BINARY_DOWNLOAD = "1";
          ELECTRON_OZONE_PLATFORM_HINT = "auto";
        };

        shellHook = ''
          export ELECTRON_OVERRIDE_DIST_PATH="${electron}/bin"
          export ELECTRON_SKIP_BINARY_DOWNLOAD="1"
          export ELECTRON_OZONE_PLATFORM_HINT="auto"
          export PATH="$PWD/node_modules/.bin:$PATH"
        '';
      };
    })
    // {
      homeManagerModules = {
        default = self.homeManagerModules.learnharness;
        learnharness = {
          config,
          lib,
          pkgs,
          ...
        }: let
          cfg = config.programs.learnharness;
          system = pkgs.stdenv.hostPlatform.system;
        in {
          options.programs.learnharness = {
            enable = lib.mkEnableOption "LearnHarness AI learning agent";
            package = lib.mkOption {
              type = lib.types.package;
              default = self.packages.${system}.default;
              description = "The LearnHarness launcher package.";
            };
          };

          config = lib.mkIf cfg.enable {
            home.packages = [cfg.package];
          };
        };
      };
    };
}
