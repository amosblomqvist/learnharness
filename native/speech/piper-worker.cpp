#include <piper.h>
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <iostream>
#include <memory>
#include <string>
#include <vector>
#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#endif
namespace {
constexpr uint32_t max_text = 16384;
uint32_t read32(const unsigned char *p) { return uint32_t(p[0]) | uint32_t(p[1]) << 8 | uint32_t(p[2]) << 16 | uint32_t(p[3]) << 24; }
void append32(std::vector<unsigned char>& b, uint32_t n) { for (int i=0;i<4;i++) b.push_back((n >> (8*i)) & 255); }
void frame(unsigned char type, uint32_t id, const std::vector<unsigned char>& payload = {}) {
 std::vector<unsigned char> b; append32(b, uint32_t(6+payload.size())); b.push_back(1); b.push_back(type); append32(b,id); b.insert(b.end(),payload.begin(),payload.end());
 std::cout.write(reinterpret_cast<const char*>(b.data()),b.size()); std::cout.flush(); if (!std::cout) throw std::runtime_error("output closed");
}
void error(uint32_t id, const std::string& code) { frame(4,id,{code.begin(),code.end()}); }
}
int main(int argc,char**argv) {
#ifdef _WIN32
 _setmode(_fileno(stdin),_O_BINARY); _setmode(_fileno(stdout),_O_BINARY);
#endif
 if(argc!=4) { std::cerr<<"Expected model, config and pronunciation data paths\n"; return 2; }
 try {
 std::unique_ptr<piper_synthesizer,decltype(&piper_free)> synth(piper_create(argv[1],argv[2],argv[3]),piper_free);
 if(!synth) { std::cerr<<"Unable to load voice\n"; return 3; }
 for (;;) {
 unsigned char prefix[4]; std::cin.read(reinterpret_cast<char*>(prefix),4);
 if(std::cin.eof() && std::cin.gcount()==0) return 0;
 if(std::cin.gcount()!=4) return 4;
 const auto size=read32(prefix); if(size<6 || size>max_text+6) return 4;
 std::vector<unsigned char> request(size); if(!std::cin.read(reinterpret_cast<char*>(request.data()),size)) return 4;
 const auto id=read32(request.data()+2);
 if(request[0]!=1 || request[1]!=1) { error(id,"unsupported_protocol"); continue; }
 std::string text(request.begin()+6,request.end());
 if(text.empty() || text.find('\0')!=std::string::npos) { error(id,"invalid_text"); continue; }
 try {
 if(piper_synthesize_start(synth.get(),text.c_str(),nullptr)!=PIPER_OK) { error(id,"synthesis_failed"); continue; }
 piper_audio_chunk chunk; int result;
 do {
 result=piper_synthesize_next(synth.get(),&chunk);
 if(result!=PIPER_OK && result!=PIPER_DONE) break;
 if(chunk.num_samples==0) continue;
 if(chunk.sample_rate<=0 || chunk.num_samples>10000000) throw std::runtime_error("invalid audio");
 std::vector<unsigned char> pcm; append32(pcm,chunk.sample_rate); pcm.reserve(4+chunk.num_samples*2);
 for(size_t i=0;i<chunk.num_samples;i++) { float f=chunk.samples[i]; if(!std::isfinite(f)) f=0; const auto s=static_cast<int16_t>(std::clamp(f,-1.0f,1.0f)*32767); pcm.push_back(s&255); pcm.push_back((uint16_t(s)>>8)&255); }
 frame(2,id,pcm);
 } while(result==PIPER_OK);
 if(result==PIPER_DONE) frame(3,id); else error(id,"synthesis_failed");
 } catch(const std::exception& ex) { std::cerr<<ex.what()<<'\n'; error(id,"synthesis_failed"); }
 }
 } catch(const std::exception& ex) { std::cerr<<ex.what()<<'\n'; return 5; }
}
