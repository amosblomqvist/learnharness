# Patch Sync Workflow (learnharness)

Panduan ini menjelaskan cara menjaga agar modifikasi kustom Anda tetap aman dan dapat diterapkan ulang secara otomatis setiap kali ada update baru dari repository upstream (`amosblomqvist/learnharness`).

---

## 🎯 Konsep Utama

1. **Perubahan Anda disimpan sebagai file `.patch` modular** di folder `patches/`.
2. Setiap kali ada update dari upstream:
   - Anda menarik commit terbaru dari upstream.
   - Patch kustom Anda diterapkan ulang di atas kode terbaru menggunakan **3-way merge** (`git am --3way`).
3. Jika upstream mengubah file yang sama dan terjadi konflik, sistem masuk ke mode **Conflict Resolution** sehingga Anda dapat menyelesaikannya di VS Code tanpa kehilangan kode.

---

## 🚀 Perintah yang Tersedia

| Perintah | Fungsi |
|---|---|
| `npm run patch:export` | Mengekspor commit kustom Anda yang berada di depan `upstream/main` menjadi file `.patch` di folder `patches/`. |
| `npm run patch:sync` | Otomatis fetch `upstream/main`, reset branch ke versi terbaru upstream, dan terapkan semua patch. |
| `npm run patch:apply` | Menerapkan seluruh patch yang ada di `patches/` ke branch saat ini. |
| `npm run patch:status` | Mengecek status patch: apakah sedang ada konflik, file mana yang konflik, atau berapa patch tersisa. |
| `npm run patch:continue` | Melanjutkan proses apply patch setelah konflik diselesaikan dan di-`git add`. |
| `npm run patch:abort` | Membatalkan proses patch dan mengembalikan repository ke kondisi sebelum apply. |

---

## 📖 Alur Kerja Rutin (Step-by-Step)

### Skenario 1: Menyimpan Perubahan Baru ke Patch
Setiap kali Anda selesai membuat fitur atau commit baru di fork Anda:
```bash
npm run patch:export
git add patches/
git commit -m "chore: update patches"
```

### Skenario 2: Mengambil Update dari Upstream
Saat repository upstream merilis update baru dan Anda ingin memperbarui fork Anda:
```bash
npm run patch:sync
```

Jika tidak ada konflik:
Semua patch akan langsung terpasang rapi di atas commit upstream terbaru. Anda tinggal menjalankan:
```bash
npm run typecheck
npm run lint
```

### Skenario 3: Jika Terjadi Konflik Kode (Merge Conflict)
Jika upstream memodifikasi bagian kode yang sama dengan yang Anda ubah:

1. Terminal akan menampilkan peringatan:
   ```text
   ⚠️ Conflict occurred while applying patches.
   ```
2. Cek file mana yang konflik dengan:
   ```bash
   npm run patch:status
   ```
3. Buka file yang berkonflik di editor (VS Code). Cari penanda konflik:
   ```text
   <<<<<<< HEAD
   (kode dari upstream)
   =======
   (kode modifikasi Anda)
   >>>>>>>
   ```
4. Pilih perubahan yang diinginkan (Accept Current / Incoming / Both), lalu simpan.
5. Tandai file yang sudah selesai:
   ```bash
   git add <nama-file>
   ```
6. Lanjutkan penerapan patch berikutnya:
   ```bash
   npm run patch:continue
   ```
7. Jika Anda ingin membatalkan dan kembali ke kondisi semula kapan saja:
   ```bash
   npm run patch:abort
   ```
