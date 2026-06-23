import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, Check, Star, Zap, Crown, Loader2, Smartphone, X, AlertCircle } from "lucide-react";
import { useProfile } from "@/hooks/useProfile";
import { supabase } from "@/lib/supabase";
import { MpesaService } from "@/lib/mpesa";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { toast } from "sonner";

const packages = [
  {
    name: "Bronze",
    type: "bronze" as const,
    price: 358,
    surveys: 15,
    icon: Star,
    gradient: "gradient-bronze",
    features: [
      "Access to standard surveys",
      "Earn KSH 150 per survey",
      "15 bonus surveys",
      "M-Pesa withdrawal",
      "Basic support",
    ],
    popular: false,
  },
  {
    name: "Silver",
    type: "silver" as const,
    price: 508,
    surveys: 30,
    icon: Zap,
    gradient: "gradient-silver",
    features: [
      "Access to premium surveys",
      "Earn KSH 200 per survey",
      "30 bonus surveys",
      "Priority M-Pesa withdrawal",
      "Daily bonus tasks",
      "Priority support",
    ],
    popular: true,
  },
  {
    name: "Gold",
    type: "gold" as const,
    price: 658,
    surveys: 50,
    icon: Crown,
    gradient: "gradient-gold",
    features: [
      "Access to ALL surveys",
      "Earn KSH 300 per survey",
      "50 bonus surveys",
      "Instant M-Pesa withdrawal",
      "Exclusive daily bonuses",
      "VIP support",
      "Early access to new surveys",
    ],
    popular: false,
  },
];

const Packages = () => {
  const navigate = useNavigate();
  const { profile, refresh } = useProfile();
  const [selected, setSelected] = useState(1);
  const [purchasing, setPurchasing] = useState(false);
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [paymentStatus, setPaymentStatus] = useState<"idle" | "processing" | "failed">("idle");
  const [phone, setPhone] = useState(profile?.phone || "");

  useEffect(() => {
    if (!phone && profile?.phone) setPhone(profile.phone);
  }, [profile?.phone]);

  const openPayment = (index: number) => {
    setSelected(index);
    setPaymentStatus("idle");
    setShowPaymentModal(true);
  };

  const finalizePurchase = async (pkg: (typeof packages)[number]) => {
    if (!profile) return;

    // Create user package record
    const { error } = await supabase
      .from("user_packages")
      .insert({
        user_id: profile.id,
        package_type: pkg.type,
        price_paid: pkg.price,
        surveys_unlocked: pkg.surveys,
        is_active: true,
        purchased_at: new Date().toISOString(),
        expires_at: null, // No expiration for now
      });

    if (error) throw error;

    // Update membership tier
    await supabase
      .from("profiles")
      .update({
        membership_tier: pkg.name,
        updated_at: new Date().toISOString(),
      })
      .eq("id", profile.id);

    await refresh();

    toast.success(`${pkg.name} package activated! You unlocked ${pkg.surveys} bonus surveys.`);
    navigate("/dashboard");
  };

  const startPayment = async () => {
    if (!profile) return;
    const pkg = packages[selected];

    if (!phone || phone.length < 9) {
      toast.error("Please enter a valid M-Pesa phone number");
      return;
    }

    setPurchasing(true);
    setPaymentStatus("processing");

    try {
      const result = await MpesaService.initiateSTKPush(
        phone,
        pkg.price,
        `PACKAGE_${pkg.type.toUpperCase()}`,
        `Purchase ${pkg.name} package`,
        profile.id,
        `package_${pkg.type}`
      );

      if (result.success && result.checkoutRequestId) {
        MpesaService.pollPaymentStatusSimple(
          result.checkoutRequestId,
          () => {
            void (async () => {
              try {
                await finalizePurchase(pkg);
                setShowPaymentModal(false);
              } catch (err: any) {
                console.error("Package activation error:", err);
                toast.error(err?.message || "Payment received but package activation failed");
                setPaymentStatus("failed");
              } finally {
                setPurchasing(false);
              }
            })();
          },
          () => {
            toast.error("Payment failed or was cancelled. Please try again.");
            setPaymentStatus("failed");
            setPurchasing(false);
          }
        );
      } else {
        toast.error(result.error || "Failed to initiate payment");
        setPaymentStatus("failed");
        setPurchasing(false);
      }
    } catch (err: any) {
      console.error("STK payment error:", err);
      toast.error(err?.message || "Failed to process payment");
      setPaymentStatus("failed");
      setPurchasing(false);
    }
  };

  return (
    <div className="min-h-screen bg-surface pb-12">
      <div className="bg-primary px-4 pt-12 pb-8 rounded-b-3xl">
        <div className="flex items-center gap-3 mb-4">
          <button onClick={() => navigate(-1)} className="w-10 h-10 rounded-full bg-primary-foreground/10 flex items-center justify-center">
            <ArrowLeft className="h-5 w-5 text-primary-foreground" />
          </button>
          <h2 className="font-display text-lg font-bold text-primary-foreground">Level Up</h2>
        </div>
        <p className="text-primary-foreground/70 text-sm">Choose a package to unlock higher-paying surveys and exclusive features.</p>
      </div>

      <div className="px-4 -mt-4 space-y-4">
        {packages.map((pkg, i) => (
          <motion.div
            key={pkg.name}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.1 }}
            onClick={() => setSelected(i)}
            className={`relative bg-card rounded-2xl overflow-hidden shadow-card cursor-pointer transition-all ${
              selected === i ? "ring-2 ring-primary shadow-premium" : ""
            }`}
          >
            {pkg.popular && (
              <div className="absolute top-0 right-0 bg-accent text-accent-foreground text-xs font-bold px-3 py-1 rounded-bl-xl">
                Most Popular
              </div>
            )}
            <div className={`${pkg.gradient} p-4 flex items-center gap-3`}>
              <div className="w-12 h-12 rounded-xl bg-card/20 backdrop-blur flex items-center justify-center">
                <pkg.icon className="h-6 w-6 text-primary-foreground" />
              </div>
              <div>
                <h3 className="font-display text-xl font-bold text-primary-foreground">{pkg.name}</h3>
                <p className="font-display text-2xl font-extrabold text-primary-foreground">
                  KSH {pkg.price}
                  <span className="text-sm font-normal text-primary-foreground/60"> /month</span>
                </p>
              </div>
            </div>
            <div className="p-4 space-y-2.5">
              {pkg.features.map((f) => (
                <div key={f} className="flex items-center gap-2">
                  <Check className="h-4 w-4 text-primary flex-shrink-0" />
                  <span className="text-sm text-foreground">{f}</span>
                </div>
              ))}
            </div>
            <div className="px-4 pb-4">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  openPayment(i);
                }}
                disabled={purchasing}
                className={`w-full rounded-xl py-3 font-bold text-sm transition ${
                  selected === i
                    ? "bg-primary text-primary-foreground shadow-premium"
                    : "bg-muted text-muted-foreground"
                } disabled:opacity-50`}
              >
                {purchasing && selected === i ? (
                  <span className="flex items-center justify-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin" /> Processing...
                  </span>
                ) : selected === i ? (
                  "Subscribe Now"
                ) : (
                  "Select Plan"
                )}
              </button>
            </div>
          </motion.div>
        ))}
      </div>

      {/* Payment Modal */}
      <Dialog
        open={showPaymentModal}
        onOpenChange={(open) => {
          if (paymentStatus === "processing") return;
          setShowPaymentModal(open);
        }}
      >
        <DialogContent className="sm:max-w-md p-0 overflow-hidden bg-card border-0">
          <div className="p-6">
            <div className="flex items-center justify-between mb-5">
              <h2 className="font-display text-xl font-bold text-foreground">Pay with M-Pesa</h2>
              <button
                onClick={() => {
                  if (paymentStatus !== "processing") setShowPaymentModal(false);
                }}
                className="p-2 hover:bg-muted rounded-full"
              >
                <X className="h-5 w-5 text-muted-foreground" />
              </button>
            </div>

            {paymentStatus === "processing" ? (
              <div className="text-center py-6">
                <div className="flex items-center justify-center mb-4">
                  <Loader2 className="h-10 w-10 animate-spin text-primary" />
                </div>
                <p className="font-bold text-foreground mb-2">Waiting for confirmation...</p>
                <p className="text-sm text-muted-foreground">
                  Check your phone and enter your M-Pesa PIN to complete payment.
                </p>
              </div>
            ) : paymentStatus === "failed" ? (
              <div className="text-center py-4">
                <div className="w-14 h-14 rounded-full bg-destructive/10 flex items-center justify-center mx-auto mb-4">
                  <AlertCircle className="h-7 w-7 text-destructive" />
                </div>
                <p className="text-muted-foreground mb-4">
                  Payment failed. Please check your M-Pesa balance and try again.
                </p>
                <button
                  onClick={() => setPaymentStatus("idle")}
                  className="w-full rounded-xl py-3 bg-primary text-primary-foreground font-bold"
                >
                  Try Again
                </button>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="bg-muted/50 rounded-xl p-4">
                  <p className="text-sm text-muted-foreground mb-1">Selected Plan</p>
                  <p className="font-display text-2xl font-bold text-foreground">
                    {packages[selected].name}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    Amount: <span className="font-bold text-foreground">KSH {packages[selected].price}</span>
                  </p>
                </div>

                <div>
                  <label className="text-sm font-medium text-foreground mb-2 block">M-Pesa Phone Number</label>
                  <div className="relative">
                    <Smartphone className="absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground" />
                    <input
                      type="tel"
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      placeholder="e.g. 0712345678"
                      className="w-full pl-12 pr-4 py-3 rounded-xl bg-muted border-0 focus:ring-2 focus:ring-primary font-medium"
                    />
                  </div>
                  <p className="text-xs text-muted-foreground mt-2">
                    You'll receive an M-Pesa STK push on this number.
                  </p>
                </div>

                <button
                  onClick={startPayment}
                  disabled={!phone || purchasing}
                  className="w-full rounded-xl py-4 bg-primary text-primary-foreground font-bold shadow-premium hover:opacity-90 transition disabled:opacity-50"
                >
                  Pay KSH {packages[selected].price}
                </button>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default Packages;
