#include <jni.h>
#include <node.h>
#include <unistd.h>
#include <cstdlib>
#include <string>
#include <vector>
#include <android/log.h>
#include <thread>
#include <algorithm>

static std::string fromJava(JNIEnv* env, jstring value) {
    const char* chars = env->GetStringUTFChars(value, nullptr);
    std::string result(chars);
    env->ReleaseStringUTFChars(value, chars);
    return result;
}

extern "C" JNIEXPORT jint JNICALL
Java_ar_com_learnharness_RuntimeService_startNode(JNIEnv* env, jclass, jstring script, jstring config, jstring cache) {
    std::string entry = fromJava(env, script), settings = fromJava(env, config), temporary = fromJava(env, cache);
    setenv("TMPDIR", temporary.c_str(), 1);
    setenv("NODE_COMPILE_CACHE", (temporary + "/node-cache").c_str(), 1);
    // Never log credentials or request bodies. Node's normal server diagnostics
    // are available in adb logcat when diagnosing startup failures.
    int pipes[2];
    if (pipe(pipes) == 0) {
        dup2(pipes[1], STDOUT_FILENO); dup2(pipes[1], STDERR_FILENO); close(pipes[1]);
        std::thread([fd = pipes[0]] {
            char buffer[1024]; ssize_t size;
            while ((size = read(fd, buffer, sizeof(buffer)-1)) > 0) {
                buffer[size] = 0;
                __android_log_write(ANDROID_LOG_INFO, "LearnHarnessNode", buffer);
            }
            close(fd);
        }).detach();
    }
    std::vector<std::string> args = {"node", "--max-old-space-size=512", entry, settings};
    // libuv requires argv strings to occupy one contiguous allocation.
    size_t total = 0; for (const auto& arg : args) total += arg.size() + 1;
    std::vector<char> storage(total); std::vector<char*> argv; size_t offset = 0;
    for (const auto& arg : args) {
        argv.push_back(storage.data() + offset);
        std::copy(arg.c_str(), arg.c_str() + arg.size() + 1, storage.data() + offset);
        offset += arg.size() + 1;
    }
    return node::Start(static_cast<int>(argv.size()), argv.data());
}
