using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;

namespace LearnHarness
{
    public static class WindowsLaunchers
    {
        [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
        private class ShellLink { }

        // IShellLinkW methods must be declared in Windows SDK vtable order.
        [ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IShellLinkW
        {
            void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int capacity, IntPtr findData, uint flags);
            void GetIDList(out IntPtr pidl);
            void SetIDList(IntPtr pidl);
            void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder description, int capacity);
            void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string description);
            void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder directory, int capacity);
            void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string directory);
            void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder arguments, int capacity);
            void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string arguments);
            void GetHotkey(out ushort hotkey);
            void SetHotkey(ushort hotkey);
            void GetShowCmd(out int show);
            void SetShowCmd(int show);
            void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder icon, int capacity, out int index);
            void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string icon, int index);
            void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string path, uint reserved);
            void Resolve(IntPtr window, uint flags);
            void SetPath([MarshalAs(UnmanagedType.LPWStr)] string path);
        }

        public static string ReadShortcutDescription(string path)
        {
            var link = (IShellLinkW)new ShellLink();
            try
            {
                ((IPersistFile)link).Load(path, 0);
                var description = new StringBuilder(1024);
                link.GetDescription(description, description.Capacity);
                return description.ToString();
            }
            finally { Marshal.ReleaseComObject(link); }
        }

        public static void CreateShortcut(string path, string target, string arguments, string description)
        {
            var link = (IShellLinkW)new ShellLink();
            try
            {
                link.SetPath(target);
                link.SetArguments(arguments);
                link.SetDescription(description);
                ((IPersistFile)link).Save(path, true);
            }
            finally { Marshal.ReleaseComObject(link); }
        }

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern IntPtr SendMessageTimeout(
            IntPtr window, uint message, IntPtr wParam, string lParam, uint flags, uint timeout, out IntPtr result);

        public static void NotifyEnvironmentChanged()
        {
            const int BroadcastWindow = 0xffff;
            const uint SettingChange = 0x1a;
            const uint AbortIfHung = 2;
            IntPtr result;
            SendMessageTimeout(new IntPtr(BroadcastWindow), SettingChange, IntPtr.Zero, "Environment", AbortIfHung, 2000, out result);
        }
    }
}
