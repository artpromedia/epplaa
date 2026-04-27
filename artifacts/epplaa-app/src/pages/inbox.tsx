import { MessageSquare } from "lucide-react";
import { useTheme } from "@/lib/theme-context";
import { ThemeToggle } from "@/components/theme-toggle";

export default function Inbox() {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";

  return (
    <div className="flex flex-col h-full w-full">
      <div className={`pt-12 pb-4 px-4 z-10 sticky top-0 ${isDark ? 'bg-[#050505] border-b border-white/10' : 'bg-[#fbeed3] border-b border-stone-400/35'}`}>
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-2xl font-bold">Inbox</h1>
          <ThemeToggle />
        </div>
        <div className="flex gap-4">
          <button className={`pb-2 border-b-2 font-bold ${isDark ? 'border-[#00ffff] text-white' : 'border-[#00b3b3] text-stone-900'}`}>
            Messages
          </button>
          <button className={`pb-2 border-b-2 border-transparent font-medium ${isDark ? 'text-white/50 hover:text-white' : 'text-stone-500 hover:text-stone-900'}`}>
            Orders
          </button>
        </div>
      </div>
      
      <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
        <div className={`w-20 h-20 rounded-full flex items-center justify-center mb-4 ${isDark ? 'bg-white/5 text-white/30' : 'bg-stone-300/35 text-stone-400'}`}>
          <MessageSquare className="w-10 h-10" />
        </div>
        <h2 className="text-lg font-bold mb-2">No messages yet</h2>
        <p className={`text-sm ${isDark ? 'text-white/50' : 'text-stone-500'}`}>
          When you contact sellers or receive updates, they'll appear here.
        </p>
        <button className={`mt-6 px-6 py-2 rounded-full font-bold text-sm text-black ${isDark ? 'bg-[#00ffff] hover:bg-[#00cccc]' : 'bg-[#00b3b3] text-white hover:bg-[#009999]'}`}>
          Start Shopping
        </button>
      </div>
    </div>
  );
}
