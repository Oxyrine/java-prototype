"""
One-command pipeline: blueprint image -> text grid (Python) -> web/level01.json (Java).

Worth having as its own script because invoking Maven correctly on this machine is
genuinely awkward: there's no JDK or Maven on PATH (only IntelliJ's bundled copies), and
Maven's launcher on Windows is mvn.cmd, a batch file, which needs JAVA_HOME set in its
environment to run at all. This script sets that up once so you don't have to.

Usage (run from the project root, School/Java Project):
    py -m pip install -r requirements.txt      # once
    py tools/build_level.py blueprints/my_house.png --width-metres 10.5
"""
import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import blueprint_to_grid  # noqa: E402

PROJECT_ROOT = Path(__file__).parent.parent

# This machine has no standalone JDK/Maven on PATH -- only the copies bundled
# with IntelliJ IDEA. Used only if `mvn` isn't already found on PATH.
FALLBACK_JAVA_HOME = Path(r"C:\Program Files\JetBrains\IntelliJ IDEA 2026.1.4\jbr")
FALLBACK_MAVEN = Path(
    r"C:\Program Files\JetBrains\IntelliJ IDEA 2026.1.4\plugins\maven\lib\maven3\bin\mvn.cmd")


def find_maven():
    """Returns (maven_path, java_home_or_None)."""
    on_path = shutil.which("mvn")
    if on_path:
        return Path(on_path), None
    if FALLBACK_MAVEN.exists():
        return FALLBACK_MAVEN, FALLBACK_JAVA_HOME
    raise SystemExit(
        "Could not find Maven on PATH or at the expected IntelliJ-bundled location:\n"
        f"  {FALLBACK_MAVEN}\n"
        "Install a JDK + Maven, or edit FALLBACK_MAVEN/FALLBACK_JAVA_HOME at the top "
        "of tools/build_level.py to point at yours.")


def run_java(blueprint_txt: Path, output_json: Path, cell_size: float, wall_height: float):
    # NOTE: this deliberately does NOT use `mvn exec:java -Dexec.args="..."`.
    # exec.args is a single string that the exec-plugin tokenizes on whitespace,
    # and this project's own path ("Main Programming", "Java Project") contains
    # spaces -- that tokenization would silently chop the blueprint path in half.
    # Compiling then invoking `java` directly with a real argv list sidesteps
    # the problem entirely: each argument stays intact no matter what it contains.
    maven, java_home = find_maven()
    env = os.environ.copy()
    if java_home is not None:
        env["JAVA_HOME"] = str(java_home)

    compile_result = subprocess.run([str(maven), "-q", "compile"], cwd=PROJECT_ROOT, env=env)
    if compile_result.returncode != 0:
        raise SystemExit(f"Maven compile failed (exit code {compile_result.returncode})")

    classpath_file = PROJECT_ROOT / "target" / "classpath.txt"
    cp_result = subprocess.run(
        [str(maven), "-q", "dependency:build-classpath", f"-Dmdep.outputFile={classpath_file}"],
        cwd=PROJECT_ROOT, env=env)
    if cp_result.returncode != 0:
        raise SystemExit(f"Maven dependency:build-classpath failed (exit code {cp_result.returncode})")

    dependency_classpath = classpath_file.read_text(encoding="utf-8").strip()
    full_classpath = str(PROJECT_ROOT / "target" / "classes") + os.pathsep + dependency_classpath

    java_exe = str(java_home / "bin" / "java.exe") if java_home is not None else "java"
    cmd = [java_exe, "-cp", full_classpath, "com.blueprint.Main",
           f"--blueprint={blueprint_txt}", f"--output={output_json}",
           f"--cellSize={cell_size}", f"--wallHeight={wall_height}"]

    result = subprocess.run(cmd, cwd=PROJECT_ROOT, env=env)
    if result.returncode != 0:
        raise SystemExit(f"Java step failed (exit code {result.returncode})")


def main():
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("image", type=Path, help="Input blueprint image (PNG/JPG/PDF)")
    parser.add_argument("--out", default="house", help="Output base name for the grid (default: house)")
    parser.add_argument("--cols", type=int, default=96)
    parser.add_argument("--fill", type=float, default=0.12)
    parser.add_argument("--width-metres", type=float, default=12.0)
    parser.add_argument("--wall-height", type=float, default=2.5)
    parser.add_argument("--dpi", type=int, default=200)
    parser.add_argument("--invert", action="store_true")
    parser.add_argument("--no-close", dest="do_close", action="store_false")
    parser.add_argument("--min-region", type=int, default=6)
    parser.add_argument("--no-seal", dest="do_seal", action="store_false")
    parser.add_argument("--keep-all-components", dest="keep_largest_only", action="store_false")
    args = parser.parse_args()

    print("=== Stage 1: image -> grid (Python) ===")
    out_txt, cell_size, wall_height, _reachable, _walls = blueprint_to_grid.convert(
        args.image, args.out, args.cols, args.fill, args.width_metres,
        args.wall_height, args.dpi, args.invert, args.do_close, args.min_region,
        args.do_seal, args.keep_largest_only)

    print()
    print("=== Stage 2: grid -> JSON (Java) ===")
    output_json = PROJECT_ROOT / "web" / "level01.json"
    run_java(out_txt, output_json, cell_size, wall_height)

    print()
    print("Done. Serve and open the result:")
    print("  py -m http.server 8000 --directory web")
    print("  http://localhost:8000")


if __name__ == "__main__":
    main()
