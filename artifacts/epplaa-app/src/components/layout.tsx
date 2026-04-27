import { Home, Compass, Plus, MessageSquare, User } from "lucide-react";
import { Link, useLocation } from "wouter";
import { useTheme } from "@/lib/theme-context";

export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";

  const isLiveRoute = location.startsWith("/live/");

  return (
    <div className="flex justify-center w-full min-h-[100dvh] bg-stone-100 dark:bg-black/90">
      <div className={`w-full max-w-[390px] h-[100dvh] relative overflow-hidden font-sans select-none flex flex-col shadow-2xl ${isDark ? 'bg-[#050505] text-white' : 'bg-[#fbeed3] text-stone-900'}`}>
        
        {/* Main Content Area */}
        <div className={`flex-1 overflow-y-auto no-scrollbar ${!isLiveRoute ? 'pb-20' : ''}`}>
          {children}
        </div>

        {/* Bottom Nav - Hidden on Live route */}
        {!isLiveRoute && (
          <div className={`absolute bottom-0 left-0 right-0 h-20 backdrop-blur-xl border-t flex items-center justify-around px-2 pb-4 z-50 ${isDark ? 'bg-[#0a0a0a]/90 border-white/5' : 'bg-[#fff5d8]/92 border-stone-400/55'}`}>
            <Link href="/" className={`flex flex-col items-center gap-1 w-16 ${location === '/' ? (isDark ? 'text-[#00ffff]' : 'text-[#00b3b3]') : (isDark ? 'text-white/50 hover:text-white' : 'text-stone-500 hover:text-stone-900')}`}>
              <Home className="h-6 w-6" />
              <span className="text-[10px] font-medium">Home</span>
            </Link>
            
            <Link href="/discover" className={`flex flex-col items-center gap-1 w-16 ${location === '/discover' ? (isDark ? 'text-[#00ffff]' : 'text-[#00b3b3]') : (isDark ? 'text-white/50 hover:text-white' : 'text-stone-500 hover:text-stone-900')}`}>
              <Compass className="h-6 w-6" />
              <span className="text-[10px] font-medium">Discover</span>
            </Link>
            
            <div className="relative -top-5">
              <Link href="/go-live" className={`flex h-14 w-14 rounded-full p-[2px] ${isDark ? 'bg-gradient-to-tr from-[#ff00ff] to-[#00ffff] shadow-[0_0_20px_rgba(255,0,255,0.4)]' : 'bg-gradient-to-tr from-[#d900d9] to-[#00b3b3] shadow-md'}`}>
                <div className={`h-full w-full rounded-full flex items-center justify-center ${isDark ? 'bg-black' : 'bg-white'}`}>
                  <Plus className={`h-6 w-6 ${isDark ? 'text-white' : 'text-stone-900'}`} />
                </div>
              </Link>
            </div>

            <Link href="/inbox" className={`flex flex-col items-center gap-1 w-16 relative ${location === '/inbox' ? (isDark ? 'text-[#00ffff]' : 'text-[#00b3b3]') : (isDark ? 'text-white/50 hover:text-white' : 'text-stone-500 hover:text-stone-900')}`}>
              <MessageSquare className="h-6 w-6" />
              <span className={`absolute top-0 right-3 w-2 h-2 rounded-full ${isDark ? 'bg-[#ff00ff]' : 'bg-[#d900d9]'}`}></span>
              <span className="text-[10px] font-medium">Inbox</span>
            </Link>
            
            <Link href="/profile" className={`flex flex-col items-center gap-1 w-16 ${location === '/profile' ? (isDark ? 'text-[#00ffff]' : 'text-[#00b3b3]') : (isDark ? 'text-white/50 hover:text-white' : 'text-stone-500 hover:text-stone-900')}`}>
              <User className="h-6 w-6" />
              <span className="text-[10px] font-medium">Profile</span>
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
