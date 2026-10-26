{
  description = "A Nix-flake-based Node.js development environment";

  inputs.nixpkgs.url = "https://flakehub.com/f/NixOS/nixpkgs/0.1"; # unstable Nixpkgs

  outputs =
    { self, ... }@inputs:

    let
      supportedSystems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
      ];
      forEachSupportedSystem =
        f:
        inputs.nixpkgs.lib.genAttrs supportedSystems (
          system:
          f {
            inherit system;
            pkgs = import inputs.nixpkgs {
              inherit system;
            };
          }
        );
    in
    {
      devShells = forEachSupportedSystem (
        { pkgs, system }:
        {

          default = pkgs.mkShellNoCC {
            shellHook = ''
              npm install
            '';
            packages = with pkgs; [
              nodejs_22
              self.formatter.${system}
            ];
          };
        }
      );
      formatter = forEachSupportedSystem ({ pkgs, ... }: pkgs.nixfmt-tree);

      packages = inputs.nixpkgs.lib.genAttrs [ "x86_64-linux" ] (
        system:
        let
          pkgs = import inputs.nixpkgs { inherit system; };
        in
        {
          default = pkgs.callPackage ./nix/package.nix { };
        }
      );
      checks = inputs.nixpkgs.lib.genAttrs [ "x86_64-linux" ] (
        system:
        let
          pkgs = import inputs.nixpkgs { inherit system; };
        in
        {
          package = self.packages.${system}.default;
          formatting =
            pkgs.runCommandLocal "check-formatting" { nativeBuildInputs = [ self.formatter.${system} ]; }
              ''
                treefmt --ci ${self}
                touch $out
              '';
        }
      );
    };
}
