{
  lib,
  buildNpmPackage,
  electron,
  makeWrapper,
}:

buildNpmPackage rec {
  pname = "learnharness";
  version = "0.0.0-git";

  src = ../.;

  npmDepsHash = "sha256-a25cTyAXbk0AA3nNdOoMQ/Q5dVangmTrxO4uo1ekvhc=";

  nativeBuildInputs = [
    makeWrapper
  ];

  # Runs `npm run build` (= next build), which the app needs.
  # Remove dontNpmBuild entirely.

  env = {
    ELECTRON_SKIP_BINARY_DOWNLOAD = 1;
    NEXT_TELEMETRY_DISABLED = 1;
  };

  postBuild = ''
    node scripts/build-server.mjs
  '';

  installPhase = ''
    runHook preInstall

    mkdir -p $out/share/${pname}
    cp -r . $out/share/${pname}

    # Recreate electron-builder's Resources/ layout
    res=$out/share/${pname}/resources
    mkdir -p $res/server
    cp -r .next/standalone $res/server/standalone
    cp electron/server-title-guard.cjs $res/server-title-guard.cjs

    # Stock electron's resourcesPath is read-only and has no server/; point at ours
    substituteInPlace $out/share/${pname}/electron/main.cjs \
      --replace-fail 'process.resourcesPath' "\"$res\""

    makeWrapper ${electron}/bin/electron $out/bin/${pname} \
      --add-flags $out/share/${pname} \
      --set NODE_ENV production

    runHook postInstall
  '';

  meta = {
    description = "An agent harness for efficient learning, taking you from your current understanding to your goal";
    homepage = "https://github.com/amosblomqvist/learnharness";
    license = lib.licenses.agpl3Only;
    mainProgram = "learnharness";
  };
}
