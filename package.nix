{ stdenv
, lib
, drvSrc ? ./.
, mkNode
, nodejs-14_x
, makeWrapper
, zlib
, libpng
, pkg-config
, optipng
, chromium
}:

mkNode {
  root = drvSrc;
  nodejs = nodejs-14_x;
  production = false;
  packageLock = ./package-lock.json;
} {
  buildInputs = [
    chromium
  ];

  nativeBuildInputs = [
    makeWrapper
  ];

  prePatch = ''
    export PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=1
  '';

  postInstall = ''
    for bin in $out/bin/*; do
      wrapProgram $out/bin/mmdc \
        --set PUPPETEER_EXECUTABLE_PATH ${chromium.outPath}/bin/chromium
    done
  '';
}

