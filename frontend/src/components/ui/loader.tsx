
import React, { useEffect, useRef, useState } from "react";
import "./AnimatedLogo.css";

interface AnimatedLogoProps {
  onComplete?: () => void;
  className?: string;
}

const AnimatedLogo: React.FC<AnimatedLogoProps> = ({
  onComplete,
  className,
}) => {
  const [visible, setVisible] = useState(true);
  const [fading, setFading] = useState(false);
  const completedRef = useRef(false);

  useEffect(() => {
    if (completedRef.current) return;

    const fadeTimer = window.setTimeout(() => setFading(true), 4000);
    const completeTimer = window.setTimeout(() => {
      if (completedRef.current) return;

      completedRef.current = true;
      setVisible(false);
      onComplete?.();
    }, 4280);

    return () => {
      window.clearTimeout(fadeTimer);
      window.clearTimeout(completeTimer);
    };
  }, [onComplete]);

  if (!visible) return null;

  return (
    <div
      className={`initial-loader${fading ? " is-fading" : ""}${className ? ` ${className}` : ""}`}
      role="status"
      aria-label="Loading KnowledgePulse"
    >
      <img src="/KP_Loader.svg" alt="" />
    </div>
  );
};

export default AnimatedLogo;
