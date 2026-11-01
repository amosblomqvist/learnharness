package ar.com.learnharness;

import org.junit.Test;
import static org.junit.Assert.*;
import java.io.*;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.zip.*;

public class PayloadInstallerTest {
    private byte[] zip(String... names) throws Exception {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        try (ZipOutputStream out = new ZipOutputStream(bytes)) {
            for (String name : names) { out.putNextEntry(new ZipEntry(name)); out.write("fixture".getBytes()); out.closeEntry(); }
        }
        return bytes.toByteArray();
    }
    private String hash(byte[] bytes) throws Exception { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)); }
    @Test public void upgradePreservesLearningDataAndReusesVerifiedBundle() throws Exception {
        File root = Files.createTempDirectory("lh-install-").toFile();
        File data = new File(root, "data/course.json"); data.getParentFile().mkdirs(); Files.write(data.toPath(), "my course".getBytes(java.nio.charset.StandardCharsets.UTF_8));
        byte[] first = zip("server.js", ".next/BUILD_ID");
        File old = PayloadInstaller.install(new ByteArrayInputStream(first), new File(root, "bundles"), hash(first));
        byte[] next = zip("server.js", ".next/BUILD_ID", "new-file.js");
        File updated = PayloadInstaller.install(new ByteArrayInputStream(next), new File(root, "bundles"), hash(next));
        assertTrue(new File(updated, "new-file.js").isFile());
        assertFalse(old.exists());
        assertEquals("my course", new String(Files.readAllBytes(data.toPath()), java.nio.charset.StandardCharsets.UTF_8));
        assertEquals(updated, PayloadInstaller.install(new ByteArrayInputStream(next), new File(root, "bundles"), hash(next)));
    }
    @Test public void traversalAndCorruptArchiveCannotReplaceWorkingBundle() throws Exception {
        File root = Files.createTempDirectory("lh-install-").toFile();
        byte[] valid = zip("server.js", ".next/BUILD_ID");
        File old = PayloadInstaller.install(new ByteArrayInputStream(valid), root, hash(valid));
        byte[] evil = zip("../../escaped", "server.js", ".next/BUILD_ID");
        assertThrows(IOException.class, () -> PayloadInstaller.install(new ByteArrayInputStream(evil), root, hash(evil)));
        assertThrows(IOException.class, () -> PayloadInstaller.install(new ByteArrayInputStream(valid), root, "a".repeat(64)));
        assertTrue(new File(old, "server.js").isFile());
        assertFalse(new File(root.getParentFile(), "escaped").exists());
    }
}
