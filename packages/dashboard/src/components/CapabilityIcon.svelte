<script lang="ts">
  import { MessageCircle, MessagesSquare, GitCompare, Bot, FileUp, FileText, Image, AudioLines, Captions, Video, Link, FolderGit2, Search, Telescope, BrainCircuit, SquareTerminal, ChartNoAxesCombined, ImagePlus, Paintbrush, Clapperboard, Music, FilePlus, Presentation, Sheet, PanelsTopLeft, FolderOpen, ListChecks, BookOpen, DatabaseZap, Quote, Download, Timer, MousePointerClick, Workflow } from '@lucide/svelte'
  const icons: Record<string, typeof MessageCircle> = {
    'conversation.chat': MessageCircle,
    'conversation.continue': MessagesSquare,
    'model.compare': GitCompare,
    'agent.execute': Bot,
    'file.upload': FileUp,
    'document.input': FileText,
    'image.input': Image,
    'audio.input': AudioLines,
    'audio.transcription': Captions,
    'video.input': Video,
    'url.input': Link,
    'repository.import': FolderGit2,
    'search.web': Search,
    'research.deep': Telescope,
    'reasoning.extended': BrainCircuit,
    'code.execute': SquareTerminal,
    'data.analyze': ChartNoAxesCombined,
    'image.generation': ImagePlus,
    'image.edit': Paintbrush,
    'video.generation': Clapperboard,
    'audio.generation': Music,
    'document.generation': FilePlus,
    'presentation.generation': Presentation,
    'spreadsheet.generation': Sheet,
    'website.generation': PanelsTopLeft,
    'workspace.native': FolderOpen,
    'workspace.instructions': ListChecks,
    'workspace.knowledge': BookOpen,
    'source.connected': DatabaseZap,
    'response.citations': Quote,
    'artifact.download': Download,
    'task.background': Timer,
    'task.interactive': MousePointerClick,
    'task.parallel': Workflow,
  }
  let { capability, size = 16 }: { capability: string; size?: number } = $props()
  let Icon = $derived(icons[capability]!)
</script>

<Icon {size} strokeWidth={1.75} aria-hidden="true" />
