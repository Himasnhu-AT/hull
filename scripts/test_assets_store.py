#!/usr/bin/env python3
"""Tests for the shared asset store in assets.py. Run: python3 -I scripts/test_assets_store.py
No network: ENGINE_ASSETS_OFFLINE makes any http call fail."""
import json, os, shutil, struct, subprocess, sys, tempfile, unittest, zlib

SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets.py")


def png():
    raw = b"\x00\xff\x00\x00"
    def chunk(t, d):
        c = struct.pack(">I", len(d)) + t + d
        return c + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


class Store(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="assets_test_")
        self.store = os.path.join(self.tmp, "store")
        self.root = self.mkroot("game1")
        self.pack = os.path.join(self.tmp, "pack")
        os.makedirs(self.pack)
        json.dump({"asset": {"version": "2.0"}, "images": [{"uri": "t.png"}]}, open(os.path.join(self.pack, "m.gltf"), "w"))
        open(os.path.join(self.pack, "t.png"), "wb").write(png())
        open(os.path.join(self.pack, "LICENSE.txt"), "w").write("CC0")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def mkroot(self, name):
        r = os.path.join(self.tmp, name)
        os.makedirs(r)
        return r

    def run_cli(self, *args, root=None, ok=True):
        env = dict(os.environ, ENGINE_ASSETS_ROOT=root or self.root, ENGINE_ASSET_STORE=self.store,
                   ENGINE_ASSETS_OFFLINE="1")
        p = subprocess.run([sys.executable, "-I", SCRIPT, *args], env=env, capture_output=True, text=True)
        if ok:
            self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        else:
            self.assertNotEqual(p.returncode, 0, p.stdout + p.stderr)
        return p

    def add_tiny(self, lic="CC0-1.0", name="tiny", root=None, ok=True):
        return self.run_cli("add", self.pack, "--license", lic, "--source", "other", "--url", "https://example.com",
                            "--author", "T", "--kind", "props", "--name", name, root=root, ok=ok)

    def cas(self):
        d = os.path.join(self.store, "cas")
        return sorted(os.listdir(d)) if os.path.isdir(d) else []

    def rd(self, root, name):
        return json.load(open(os.path.join(root, name)))

    def test_full_flow_symlink_and_copy(self):
        self.add_tiny()
        self.assertEqual(self.rd(self.root, "assets.manifest.json"), {"items": ["props/tiny"]})
        idx = self.rd(self.store, "index.json")
        h = idx["props/tiny"]["current"]
        self.assertEqual(idx["props/tiny"]["history"], [h])
        self.assertEqual(self.cas(), [h])
        self.run_cli("lock")
        lock = self.rd(self.root, "assets.lock.json")["items"]["props/tiny"]
        self.assertEqual(lock["hash"], h)
        self.assertEqual(lock["license"], "CC0-1.0")
        dest = os.path.join(self.root, "assets/library/props/tiny")
        self.run_cli("sync")
        self.assertTrue(os.path.islink(dest))
        self.assertTrue(os.path.exists(os.path.join(dest, "m.gltf")))
        lic = self.rd(os.path.join(self.root, "assets/library"), "LICENSES.json")
        self.assertEqual(lic["props/tiny"]["author"], "T")
        self.assertIn("props/tiny", open(os.path.join(self.root, "ATTRIBUTION.md")).read())
        self.run_cli("check")
        # copy mode replaces a symlink
        self.run_cli("sync", "--copy")
        self.assertFalse(os.path.islink(dest))
        self.assertTrue(os.path.isfile(os.path.join(dest, "t.png")))
        # real dir left alone without --force
        p = self.run_cli("sync")
        self.assertIn("left alone", p.stdout)
        self.assertFalse(os.path.islink(dest))
        self.run_cli("sync", "--force")
        self.assertTrue(os.path.islink(dest))
        self.assertIn("props/tiny", self.run_cli("store", "list").stdout)
        self.assertEqual(self.run_cli("store", "path").stdout.strip(), self.store)

    def test_two_games_share_store(self):
        self.add_tiny()
        root2 = self.mkroot("game2")
        self.add_tiny(root=root2)
        self.assertEqual(len(self.cas()), 1)
        self.run_cli("lock", root=root2)
        self.run_cli("sync", root=root2)
        self.assertEqual(os.path.realpath(os.path.join(root2, "assets/library/props/tiny")),
                         os.path.realpath(os.path.join(self.store, "cas", self.cas()[0])))

    def test_tamper_fails(self):
        self.add_tiny()
        self.run_cli("lock")
        cas = os.path.join(self.store, "cas", self.cas()[0])
        open(os.path.join(cas, "t.png"), "ab").write(b"x")
        p = self.run_cli("sync", ok=False)
        self.assertIn("hash mismatch", p.stderr)
        p = self.run_cli("sync", "--copy", ok=False)
        self.assertIn("hash mismatch", p.stderr)
        self.assertFalse(os.path.exists(os.path.join(self.root, "assets/library/props/tiny")))

    def test_missing_store_item_fails(self):
        self.add_tiny()
        self.run_cli("lock")
        shutil.rmtree(os.path.join(self.store, "cas"))
        self.assertIn("missing", self.run_cli("sync", ok=False).stderr)

    def test_cc_by_attribution(self):
        self.add_tiny(lic="CC-BY-4.0")
        self.run_cli("lock")
        self.run_cli("sync")
        txt = open(os.path.join(self.root, "ATTRIBUTION.md")).read()
        self.assertIn("credit is required", txt)
        self.assertIn("| props/tiny | T | CC-BY-4.0 | https://example.com |", txt)

    def test_forbidden_licence_refused(self):
        p = self.add_tiny(lic="ue-only", ok=False)
        self.assertIn("cannot be imported", p.stderr)
        self.assertEqual(self.cas(), [])
        # a forbidden licence smuggled into the index is refused by lock
        self.add_tiny()
        idx = self.rd(self.store, "index.json")
        idx["props/tiny"]["entry"]["license"] = "ue-only"
        json.dump(idx, open(os.path.join(self.store, "index.json"), "w"))
        self.run_cli("lock", ok=False)

    def test_add_known_key_no_network(self):
        self.add_tiny()
        # key known to the store: no network, manifest updated
        p = self.run_cli("add", "props/tiny", root=self.mkroot("g3"))
        self.assertIn("already in the store", p.stdout)
        # a catalog kit whose key is in the index is not downloaded either
        idx = self.rd(self.store, "index.json")
        idx["cars/kenney-car-kit"] = idx["props/tiny"]
        json.dump(idx, open(os.path.join(self.store, "index.json"), "w"))
        r = self.mkroot("g4")
        self.run_cli("add", "kenney-car-kit", root=r)
        self.assertEqual(self.rd(r, "assets.manifest.json"), {"items": ["cars/kenney-car-kit"]})
        # unknown key / a kit not in the store would need the network: fails offline
        self.run_cli("add", "props/nope", ok=False)
        self.run_cli("add", "kenney-city-kit-roads", ok=False)

    def test_manifest_sorted_dedup(self):
        self.add_tiny(name="zed")
        self.add_tiny(name="alpha")
        self.add_tiny(name="zed")
        self.assertEqual(self.rd(self.root, "assets.manifest.json")["items"], ["props/alpha", "props/zed"])
        self.assertEqual(len(self.cas()), 1)


if __name__ == "__main__":
    unittest.main()
