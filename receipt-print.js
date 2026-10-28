(function () {
  const PAPER_WIDTH_MM = 58;
  const SCALE = 3;
  const WIDTH = Math.round(PAPER_WIDTH_MM * 96 / 25.4);
  const PADDING = 8;
  const INK_WIDTH = WIDTH - PADDING * 2;

  function addWrappedText(commands, ctx, text, x, y, maxWidth, font, lineHeight, align) {
    ctx.font = font;
    const words = String(text).split(/\s+/).flatMap(word => {
      if (ctx.measureText(word).width <= maxWidth) return [word];
      const fragments = [];
      let fragment = '';
      Array.from(word).forEach(character => {
        const candidate = fragment + character;
        if (fragment && ctx.measureText(candidate).width > maxWidth) {
          fragments.push(fragment);
          fragment = character;
        } else {
          fragment = candidate;
        }
      });
      if (fragment) fragments.push(fragment);
      return fragments;
    });
    let line = '';
    const lines = [];

    words.forEach(word => {
      const candidate = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(candidate).width > maxWidth) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    });
    if (line) lines.push(line);

    lines.forEach(value => {
      commands.push({ type: 'text', text: value, x, y, font, align: align || 'left' });
      y += lineHeight;
    });
    return y;
  }

  function createReceiptPng(booking) {
    if (!booking || !Array.isArray(booking.items)) {
      throw new Error('Receipt data is incomplete.');
    }

    const measureCanvas = document.createElement('canvas');
    const measureContext = measureCanvas.getContext('2d');
    if (!measureContext) throw new Error('This browser cannot render receipt images.');

    const commands = [];
    let y = PADDING;
    const regularFont = '12px Arial, Helvetica, sans-serif';
    const boldFont = 'bold 12px Arial, Helvetica, sans-serif';
    const smallFont = '11px Arial, Helvetica, sans-serif';
    const lineHeight = 15;

    y = addWrappedText(commands, measureContext, 'N CAFE', PADDING, y, INK_WIDTH, 'bold 17px Arial, Helvetica, sans-serif', 21, 'center');
    y = addWrappedText(commands, measureContext, 'RECEIPT', PADDING, y, INK_WIDTH, boldFont, lineHeight, 'center');
    y += 3;
    commands.push({ type: 'rule', y });
    y += 6;

    [
      `Receipt: ${booking.id || '—'}`,
      `Customer: ${booking.customerName || '—'}`,
      `Phone: ${booking.customerPhone || '—'}`,
      `Date: ${booking.bookingTime ? new Date(booking.bookingTime).toLocaleString() : '—'}`,
      `Payment: ${booking.paymentMethod || '—'}`
    ].forEach(line => {
      y = addWrappedText(commands, measureContext, line, PADDING, y, INK_WIDTH, regularFont, lineHeight);
    });

    y += 3;
    commands.push({ type: 'rule', y });
    y += 6;

    booking.items.forEach(item => {
      const quantity = Number(item.quantity) || 0;
      const amount = `₹${(Number(item.price) || 0) * quantity}`;
      const nameAndQuantity = `${item.name || 'Item'} x${quantity}`;
      measureContext.font = regularFont;
      const amountWidth = measureContext.measureText(amount).width;
      const nameWidth = INK_WIDTH - amountWidth - 8;
      y = addWrappedText(commands, measureContext, nameAndQuantity, PADDING, y, nameWidth, regularFont, lineHeight);
      commands.push({
        type: 'text',
        text: amount,
        x: WIDTH - PADDING,
        y: y - lineHeight,
        font: regularFont,
        align: 'right'
      });
    });

    y += 3;
    commands.push({ type: 'rule', y });
    y += 6;
    y = addWrappedText(
      commands,
      measureContext,
      `TOTAL PAID: ₹${Number(booking.totalAmount) || 0}`,
      PADDING,
      y,
      INK_WIDTH,
      'bold 14px Arial, Helvetica, sans-serif',
      18
    );
    y += 3;
    y = addWrappedText(commands, measureContext, 'Thank you for ordering at N Cafe!', PADDING, y, INK_WIDTH, smallFont, 14, 'center');

    const canvas = document.createElement('canvas');
    canvas.width = WIDTH * SCALE;
    canvas.height = Math.ceil(y + PADDING) * SCALE;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('This browser cannot render receipt images.');
    context.scale(SCALE, SCALE);
    context.fillStyle = '#000';
    context.strokeStyle = '#000';
    context.lineWidth = 0.7;
    context.textBaseline = 'top';

    commands.forEach(command => {
      if (command.type === 'rule') {
        context.setLineDash([2, 2]);
        context.beginPath();
        context.moveTo(PADDING, command.y);
        context.lineTo(WIDTH - PADDING, command.y);
        context.stroke();
        context.setLineDash([]);
        return;
      }
      context.font = command.font;
      context.textAlign = command.align;
      context.fillText(command.text, command.x, command.y);
    });

    return canvas.toDataURL('image/png');
  }

  function printReceiptPng(booking, onAfterPrint, onError) {
    let frame;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (frame) frame.remove();
      if (onAfterPrint) onAfterPrint();
    };
    const fail = error => {
      if (frame) frame.remove();
      if (onError) onError(error);
      else console.error('Receipt PNG printing failed:', error);
    };

    try {
      const png = createReceiptPng(booking);
      frame = document.createElement('iframe');
      frame.title = 'Receipt print frame';
      frame.style.cssText = 'position:fixed;left:0;top:0;width:58mm;height:100vh;border:0;z-index:-1;';
      frame.srcdoc = '<!doctype html><html><head><meta charset="utf-8"><style id="receipt-print-style">@page{size:58mm auto;margin:0}html,body{width:58mm;margin:0;padding:0;background:transparent}img{display:block;width:58mm;height:auto;margin:0;padding:0}</style></head><body></body></html>';

      frame.addEventListener('load', () => {
        const printWindow = frame.contentWindow;
        const image = frame.contentDocument.createElement('img');
        image.alt = 'Text-only cafe receipt';
        image.onload = () => {
          const pageHeightMm = Math.ceil((image.naturalHeight / image.naturalWidth) * PAPER_WIDTH_MM + 1);
          const style = frame.contentDocument.getElementById('receipt-print-style');
          style.textContent = `@page{size:${PAPER_WIDTH_MM}mm ${pageHeightMm}mm;margin:0}html,body{width:${PAPER_WIDTH_MM}mm;height:${pageHeightMm}mm;margin:0;padding:0;overflow:hidden;background:transparent}img{display:block;width:${PAPER_WIDTH_MM}mm;height:auto;margin:0;padding:0}`;
          frame.style.height = `${pageHeightMm}mm`;
          printWindow.addEventListener('afterprint', finish, { once: true });
          window.addEventListener('afterprint', finish, { once: true });
          try {
            printWindow.focus();
            printWindow.print();
          } catch (error) {
            fail(error);
          }
        };
        image.onerror = () => fail(new Error('Could not load the generated receipt image.'));
        image.src = png;
        frame.contentDocument.body.appendChild(image);
      }, { once: true });

      document.body.appendChild(frame);
    } catch (error) {
      fail(error);
    }
  }

  window.printReceiptPng = printReceiptPng;
})();
