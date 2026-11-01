package ar.com.learnharness;

import java.io.*;
import java.security.*;
import java.util.UUID;
import java.util.zip.*;

/** Only replaces the packaged code directory; learning data lives elsewhere. */
final class PayloadInstaller {
    static File install(InputStream input, File bundles, String digest) throws IOException {
        if (!digest.matches("[a-f0-9]{64}")) throw new IOException("Invalid bundle digest");
        File target = new File(bundles, digest);
        if (new File(target, ".installed").isFile()) { input.close(); return target; }
        if (!bundles.isDirectory() && !bundles.mkdirs()) throw new IOException("Cannot create bundle directory");
        File stage = new File(bundles, ".staging-" + UUID.randomUUID());
        if (!stage.mkdir()) throw new IOException("Cannot stage bundle");
        try {
            MessageDigest hash = MessageDigest.getInstance("SHA-256");
            DigestInputStream checked = new DigestInputStream(input, hash);
            try (ZipInputStream zip = new ZipInputStream(checked)) {
                String prefix = stage.getCanonicalPath() + File.separator;
                byte[] buffer = new byte[65536]; long bytes = 0; int entries = 0;
                ZipEntry entry;
                while ((entry = zip.getNextEntry()) != null) {
                    if (++entries > 100000) throw new IOException("Too many bundle entries");
                    File dest = new File(stage, entry.getName());
                    if (!dest.getCanonicalPath().startsWith(prefix)) throw new IOException("Invalid bundle path");
                    if (entry.isDirectory()) { if (!dest.isDirectory() && !dest.mkdirs()) throw new IOException("Cannot create directory"); continue; }
                    if (!dest.getParentFile().isDirectory() && !dest.getParentFile().mkdirs()) throw new IOException("Cannot create parent");
                    try (OutputStream out = new FileOutputStream(dest)) {
                        int count;
                        while ((count = zip.read(buffer)) != -1) {
                            bytes += count;
                            if (bytes > 1073741824L) throw new IOException("Bundle exceeds size limit");
                            out.write(buffer, 0, count);
                        }
                    }
                }
                // ZipInputStream may leave the central directory unread.
                while (checked.read(buffer) != -1) { }
            }
            StringBuilder actual = new StringBuilder(); for (byte b : hash.digest()) actual.append(String.format("%02x", b & 255));
            if (!digest.equals(actual.toString())) throw new IOException("Bundle checksum mismatch");
            if (!new File(stage, "server.js").isFile() || !new File(stage, ".next/BUILD_ID").isFile()) throw new IOException("Incomplete app bundle");
            if (!new File(stage, ".installed").createNewFile()) throw new IOException("Cannot finish bundle");
            if (target.exists()) remove(target);
            if (!stage.renameTo(target)) throw new IOException("Cannot activate app bundle");
            File[] obsolete = bundles.listFiles();
            if (obsolete != null) for (File file : obsolete) if (!file.equals(target)) remove(file);
            return target;
        } catch (NoSuchAlgorithmException error) { throw new IOException(error); }
        finally { if (stage.exists()) remove(stage); }
    }
    private static void remove(File file) throws IOException {
        if (file.isDirectory()) { File[] children = file.listFiles(); if (children != null) for (File child : children) remove(child); }
        if (file.exists() && !file.delete()) throw new IOException("Cannot remove stale bundle");
    }
}
