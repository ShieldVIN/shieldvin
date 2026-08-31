/**
 * Phone nav menu.
 *
 * Under 700px the bar is the brand and a button; the links live in a panel the
 * button opens. Everything visual is in site.css, so a page renders correctly
 * before this module arrives and the links stay reachable if it never does:
 * the button is the only thing that needs wiring, and it is inert until then.
 *
 * SPDX-License-Identifier: Apache-2.0
 */
const nav = document.querySelector('nav');
const burger = nav?.querySelector('.nav-burger');
const links = nav?.querySelector('.nav-links');

if (nav && burger && links) {
    const set = (open) => {
        nav.classList.toggle('nav-open', open);
        burger.setAttribute('aria-expanded', String(open));
    };

    burger.addEventListener('click', () => set(!nav.classList.contains('nav-open')));

    // A tap on a link navigates, but same-page anchors do not, and leaving the
    // panel covering the section the reader just asked for would be rude.
    links.addEventListener('click', (e) => {
        if (e.target.closest('a')) set(false);
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && nav.classList.contains('nav-open')) {
            set(false);
            burger.focus();
        }
    });

    // Leaving it open across the breakpoint would strand the class on a bar
    // that is a plain row again.
    matchMedia('(max-width:700px)').addEventListener('change', (e) => {
        if (!e.matches) set(false);
    });
}
