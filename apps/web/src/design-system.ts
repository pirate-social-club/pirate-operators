// Single app-owned design-system surface. Keep per-module imports: loading the
// vendored package barrel emits every asset, including the brand-mark PNG.
// Package types stay at their owning modules so an internals migration edits
// this adapter rather than every call site.
export { Button, buttonVariants } from "@/components/actions/button/button";
export { Chip } from "@/components/actions/chip/chip";
export { IconButton } from "@/components/actions/icon-button/icon-button";

export { Avatar } from "@/components/data-display/avatar/avatar";
export { BadgedCircle } from "@/components/data-display/badged-circle/badged-circle";
export {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
} from "@/components/data-display/card/card";
export { Type } from "@/components/data-display/type/type";

export {
  Checkbox,
  CheckboxLabel,
} from "@/components/forms/checkbox/checkbox";
export { Combobox } from "@/components/forms/combobox/combobox";
export { Input } from "@/components/forms/input/input";
export {
  RadioGroup,
  RadioGroupItem,
} from "@/components/forms/radio-group/radio-group";
export { Switch } from "@/components/forms/switch/switch";
export {
  TextField,
  TextFieldInput,
  TextFieldLabel,
} from "@/components/forms/text-field/text-field";
export { Textarea } from "@/components/forms/textarea/textarea";

export {
  IconArrowCounterClockwise,
  IconArrowDown,
  IconArrowLeft,
  IconArrowSquareOut,
  IconArrowUp,
  IconArrowsClockwise,
  IconBell,
  IconBroadcast,
  IconCalendarBlank,
  IconCaretLeft,
  IconCheck,
  IconCheckCircle,
  IconClock,
  IconCopy,
  IconDotsThree,
  IconFileText,
  IconFire,
  IconGift,
  IconHouse,
  IconImage,
  IconLink,
  IconList,
  IconLock,
  IconMagnifyingGlass,
  IconMapPin,
  IconMicrophone,
  IconMicrophoneStage,
  IconMusicNote,
  IconPause,
  IconPlay,
  IconPlaylist,
  IconPlus,
  IconStop,
  IconTrash,
  IconUploadSimple,
  IconVideoCamera,
  IconWallet,
  IconWarningCircle,
  IconX,
} from "@/components/media/icons";
export { MediaControlButton } from "@/components/media/media-control-button/media-control-button";
export { Scrubber } from "@/components/media/scrubber/scrubber";
export {
  NetworkBase,
  NetworkBitcoin,
  NetworkEthereum,
  NetworkOptimism,
  NetworkTempo,
  TokenBTC,
  TokenDAI,
  TokenETH,
  TokenLINK,
  TokenSOL,
  TokenUSDC,
  TokenUSDT,
} from "@/components/media/web3-icons";

export { Spinner } from "@/components/feedback/spinner/spinner";
export {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/overlays/dropdown-menu/dropdown-menu";
export {
  Modal,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from "@/patterns/overlays/modal/modal";
export {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/overlays/sheet/sheet";
export { Toaster, toast } from "@/components/overlays/toast/toast";

export { ActionFooterShell } from "@/patterns/layout/action-footer-shell/action-footer-shell";
export { AppHeader } from "@/patterns/navigation/app-header/app-header";
export { CommunityAvatar } from "@/patterns/engagement/community-avatar/community-avatar";
export {
  FlatTabBar,
  FlatTabButton,
} from "@/patterns/navigation/flat-tabs/flat-tabs";
export {
  FormFieldLabel,
  FormNote,
  FormSectionHeading,
} from "@/patterns/forms/form-layout/form-layout";
export { MobilePageHeader } from "@/patterns/navigation/mobile-page-header/mobile-page-header";

export { cn } from "@/lib/cn";
export { createMediaQuery } from "@/lib/media-query";
